import { getEditableManualVersion, getManualSelection, validateManualTimetable } from '../models/adminModel.js'
import { writeAudit } from '../models/auditModel.js'
import { insertRecord } from '../models/dataHelpers.js'

const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const maxAssignmentChecks = 250000

function timeMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function conflict(type, message) {
  return { type, message }
}

function addConflict(conflicts, item) {
  if (!conflicts.some((existing) => existing.type === item.type && existing.message === item.message)) conflicts.push(item)
}

function slotDuration(slot) {
  return timeMinutes(slot.end) - timeMinutes(slot.start)
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart
}

function formatPeriod(entry) {
  return `${entry.day} ${entry.start}-${entry.end}`
}

function hasRequiredAcademicRelationship(subject, selection) {
  return subject.academicYearId === selection.academicYear.id
    && subject.departmentId === selection.department.id
    && subject.programId === selection.program.id
    && subject.batchId === selection.batch.id
    && subject.semesterId === selection.semester.id
}

async function getSectionStudentCount(database, selection) {
  const section = selection.section
  if (Number.isSafeInteger(section?.studentCount) && section.studentCount >= 0) return section.studentCount
  if (section?.id) {
    const assignedCount = await database.collection('users').countDocuments({
      role: 'student', status: 'Active', sectionId: section.id,
    })
    if (assignedCount) return assignedCount
  }
  return database.collection('users').countDocuments({
    role: 'student', status: 'Active',
    cohort: `${selection.batch.name} · ${section.name}`,
    programId: selection.program.id,
  })
}

export async function generateManualTimetable(database, user, input) {
  let selection
  try {
    selection = await getManualSelection(database, user, input)
  } catch (error) {
    if (error.status === 400) {
      return { generated: false, conflicts: [conflict('INVALID_ACADEMIC_RELATIONSHIP', error.message)] }
    }
    throw error
  }
  const version = await getEditableManualVersion(database, user, input, selection)

  const sectionFilter = {
    departmentId: selection.department.id, programId: selection.program.id,
    batchId: selection.batch.id, semesterId: selection.semester.id, sectionId: selection.section.id,
  }
  const existingEntries = await database.collection('schedules').find({ ...sectionFilter, entrySource: 'manual', versionId: version.id }).toArray()
  if (existingEntries.length) {
    return {
      generated: false,
      conflicts: [conflict('GENERATION_REQUIRES_EMPTY_TIMETABLE', 'This section already has manual entries. Remove them or choose a different section before generating.')],
    }
  }

  const cohort = `${selection.batch.name} · ${selection.section.name}`

  const [subjects, faculty, rooms, workingDays, timeSlots, blockedSlots, persistedSchedules, studentCount] = await Promise.all([
    database.collection('subjects').find({
      status: 'Active', academicYearId: selection.academicYear.id,
      departmentId: selection.department.id, programId: selection.program.id,
      batchId: selection.batch.id, semesterId: selection.semester.id,
    }).sort({ code: 1 }).toArray(),
    database.collection('users').find({ role: 'faculty', status: 'Active', departmentId: selection.department.id }).sort({ name: 1 }).toArray(),
    database.collection('rooms').find({ status: 'Active', campusId: selection.department.campusId }).sort({ name: 1 }).toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
    database.collection('time_slots').find({ type: 'CLASS', status: 'Active' }).toArray(),
    database.collection('time_slots').find({ type: { $in: ['BREAK', 'LUNCH'] }, status: 'Active' }).toArray(),
    database.collection('schedules').find({}, {
      projection: {
        id: 1, day: 1, start: 1, end: 1, facultyId: 1, roomId: 1, sectionId: 1, cohort: 1,
        versionId: 1, status: 1, subjectId: 1, code: 1, departmentId: 1, classType: 1,
      },
    }).toArray(),
    getSectionStudentCount(database, selection),
  ])

  const conflicts = []
  if (!subjects.length) conflicts.push(conflict('NO_SUBJECTS', 'No active subjects are configured for the selected academic structure.'))
  if (!workingDays.length) conflicts.push(conflict('NO_WORKING_DAYS', 'No working days are enabled.'))
  const workdayNames = new Set(workingDays.map((day) => day.day))
  const possibleSlots = timeSlots.filter((slot) => workdayNames.has(slot.day))
    .sort((left, right) => dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day)
      || left.start.localeCompare(right.start) || left.sequence - right.sequence)
  if (!possibleSlots.length) conflicts.push(conflict('NO_CLASS_SLOTS', 'No active CLASS time slots are available on enabled working days.'))

  // In-memory indexes so the backtracking search never hits the database.
  const blockedSlotsByDay = new Map()
  for (const slot of blockedSlots) {
    const daySlots = blockedSlotsByDay.get(slot.day) || []
    daySlots.push(slot)
    blockedSlotsByDay.set(slot.day, daySlots)
  }
  const placementsByDay = new Map()
  for (const entry of persistedSchedules) {
    if (!entry.day || !entry.start || !entry.end) continue
    const dayEntries = placementsByDay.get(entry.day) || []
    dayEntries.push(entry)
    placementsByDay.set(entry.day, dayEntries)
  }
  const persistedMinutesBySubject = new Map()
  for (const entry of persistedSchedules) {
    if (entry.versionId !== version.id || entry.sectionId !== selection.section.id) continue
    const key = entry.subjectId != null ? `id:${entry.subjectId}` : `code:${entry.code}:${entry.departmentId}`
    const minutes = Math.max(0, timeMinutes(entry.end) - timeMinutes(entry.start))
    persistedMinutesBySubject.set(key, (persistedMinutesBySubject.get(key) || 0) + minutes)
  }
  function persistedMinutesFor(subject) {
    return (persistedMinutesBySubject.get(`id:${subject.id}`) || 0)
      + (persistedMinutesBySubject.get(`code:${subject.code}:${selection.department.id}`) || 0)
  }
  function matchesSubject(entry, subject) {
    return entry.subjectId === subject.id
      || (!entry.subjectId && entry.code === subject.code && entry.departmentId === selection.department.id)
  }

  const facultyById = new Map(faculty.map((item) => [item.id, item]))
  const requirements = []
  for (const subject of subjects) {
    const weeklyHours = Number(subject.weeklyHours)
    const theoryHours = Number(subject.theoryHours)
    const practicalHours = Number(subject.practicalHours)
    if (!Number.isInteger(weeklyHours) || weeklyHours < 1
      || !Number.isInteger(theoryHours) || theoryHours < 0
      || !Number.isInteger(practicalHours) || practicalHours < 0
      || theoryHours + practicalHours !== weeklyHours) {
      addConflict(conflicts, conflict('INVALID_WEEKLY_REQUIREMENT', `${subject.code} ${subject.name} has invalid configured weekly hours.`))
      continue
    }
    if (subject.requiresLab && practicalHours === 0) {
      addConflict(conflicts, conflict('INVALID_WEEKLY_REQUIREMENT', `${subject.code} ${subject.name} requires a lab but has no configured practical hours.`))
      continue
    }
    if (!hasRequiredAcademicRelationship(subject, selection)) {
      addConflict(conflicts, conflict('INVALID_ACADEMIC_RELATIONSHIP', `${subject.code} ${subject.name} does not belong to the selected academic structure.`))
      continue
    }
    if (subject.facultyId && !facultyById.has(subject.facultyId)) {
      addConflict(conflicts, conflict('NO_ELIGIBLE_FACULTY', `${subject.code} ${subject.name} has an assigned faculty member who is inactive or outside the department.`))
      continue
    }
    for (const [classType, hours] of [['LECTURE', theoryHours], ['LAB', practicalHours]]) {
      if (hours > 0) requirements.push({ subject, classType, remainingMinutes: hours * 60 })
    }
  }
  if (conflicts.length) return { generated: false, conflicts }

  const generatedEntries = []
  let assignmentChecks = 0
  let searchLimitExceeded = false
  const resourceConflicts = []

  // Mirrors validateTimetableEntry, but works purely from the data loaded above.
  function evaluateCandidate(requirement, slot, facultyMember, room) {
    const { subject, classType } = requirement
    const candidateConflicts = []
    const period = formatPeriod(slot)
    const start = timeMinutes(slot.start)
    const end = timeMinutes(slot.end)

    for (const block of blockedSlotsByDay.get(slot.day) || []) {
      if (overlaps(start, end, timeMinutes(block.start), timeMinutes(block.end))) {
        addConflict(candidateConflicts, conflict('NON_CLASS_TIME_SLOT', `Classes cannot be scheduled during the configured ${block.type.toLowerCase()} period ${formatPeriod({ ...block, day: slot.day })}.`))
      }
    }

    const dayPlacements = [...(placementsByDay.get(slot.day) || []), ...generatedEntries.filter((entry) => entry.day === slot.day)]
    for (const existing of dayPlacements) {
      if (existing.status === 'Archived') continue
      if (version.id && existing.versionId && existing.versionId !== version.id
        && selection.section.id && existing.sectionId === selection.section.id) continue
      if (!overlaps(start, end, timeMinutes(existing.start), timeMinutes(existing.end))) continue
      if (existing.facultyId === facultyMember.id) {
        addConflict(candidateConflicts, conflict('FACULTY_CONFLICT', `${facultyMember.name} is already assigned during ${period}.`))
      }
      if (existing.roomId === room.id) {
        const isLab = room.type?.toLowerCase().includes('lab')
        addConflict(candidateConflicts, conflict(isLab ? 'LAB_CONFLICT' : 'ROOM_CONFLICT', `${isLab ? 'Laboratory' : 'Room'} ${room.name} is already assigned during ${period}.`))
      }
      const sameSection = existing.sectionId === selection.section.id
        || (cohort && existing.cohort === cohort)
      if (sameSection) {
        addConflict(candidateConflicts, conflict('SECTION_CONFLICT', `${selection.section.name || cohort || 'Section'} already has a class during ${period}.`))
      }
    }

    const legacyDays = String(facultyMember.availabilityDays || '').split(',').map((day) => day.trim()).filter(Boolean)
    const unavailableSlot = (Array.isArray(facultyMember.unavailableSlots) ? facultyMember.unavailableSlots : [])
      .find((slotItem) => slotItem.day === slot.day && overlaps(start, end, timeMinutes(slotItem.start), timeMinutes(slotItem.end)))
    if (facultyMember.available === false || (legacyDays.length && !legacyDays.includes(slot.day)) || unavailableSlot) {
      addConflict(candidateConflicts, conflict('FACULTY_UNAVAILABLE', `${facultyMember.name} is unavailable during ${period}.`))
    }

    if ((selection.section || cohort) && Number.isFinite(Number(room.capacity)) && Number(room.capacity) < studentCount) {
      addConflict(candidateConflicts, conflict('ROOM_CAPACITY', `${room.name} holds ${room.capacity} students, but ${selection.section.name || cohort} has ${studentCount}.`))
    }

    const allocatedEntries = [
      ...persistedSchedules.filter((entry) => matchesSubject(entry, subject)
        && entry.versionId === version.id && entry.sectionId === selection.section.id),
      ...generatedEntries.filter((entry) => matchesSubject(entry, subject)
        && entry.versionId === version.id
        && (!selection.section.id || entry.sectionId === selection.section.id)
        && (!cohort || entry.cohort === cohort)),
    ]
    const allocatedMinutes = persistedMinutesFor(subject)
      + allocatedEntries.reduce((total, entry) => total + Math.max(0, timeMinutes(entry.end) - timeMinutes(entry.start)), 0)
    if (allocatedMinutes + (end - start) > Number(subject.weeklyHours) * 60) {
      addConflict(candidateConflicts, conflict('WEEKLY_SUBJECT_HOURS', `${subject.name} would exceed its configured ${subject.weeklyHours} weekly hours.`))
    } else {
      const typeHours = classType === 'LAB' ? subject.practicalHours : subject.theoryHours
      if (Number.isFinite(Number(typeHours)) && Number(typeHours) >= 0 && classType) {
        const allocatedTypeMinutes = allocatedEntries
          .filter((entry) => entry.classType === classType)
          .reduce((total, entry) => total + Math.max(0, timeMinutes(entry.end) - timeMinutes(entry.start)), 0)
        if (allocatedTypeMinutes + (end - start) > Number(typeHours) * 60) {
          addConflict(candidateConflicts, conflict('WEEKLY_SUBJECT_HOURS', `${subject.name} would exceed its configured ${classType === 'LAB' ? 'practical' : 'theory'} hours.`))
        }
      }
    }

    return candidateConflicts
  }

  function getValidAssignments(requirement) {
    const eligibleFaculty = requirement.subject.facultyId
      ? faculty.filter((item) => item.id === requirement.subject.facultyId)
      : faculty
    const eligibleRooms = rooms.filter((room) => requirement.classType === 'LAB'
      ? room.type.toLowerCase().includes('lab')
      : !room.type.toLowerCase().includes('lab'))
    const assignments = []
    if (!eligibleFaculty.length) {
      addConflict(resourceConflicts, conflict('NO_ELIGIBLE_FACULTY', `${requirement.subject.code} ${requirement.subject.name} has no active faculty available.`))
      return assignments
    }
    if (!eligibleRooms.length) {
      addConflict(resourceConflicts, conflict(requirement.classType === 'LAB' ? 'NO_LABORATORY' : 'NO_ELIGIBLE_ROOM', `${requirement.subject.code} ${requirement.subject.name} has no suitable room.`))
      return assignments
    }

    for (const slot of possibleSlots) {
      const duration = slotDuration(slot)
      if (duration <= 0 || duration > requirement.remainingMinutes) continue
      for (const facultyMember of eligibleFaculty) {
        for (const room of eligibleRooms) {
          assignmentChecks += 1
          if (assignmentChecks > maxAssignmentChecks) {
            searchLimitExceeded = true
            return assignments
          }
          const entry = {
            entrySource: 'manual', versionId: version.id, versionNumber: version.versionNumber,
            academicYearId: selection.academicYear.id,
            departmentId: selection.department.id, programId: selection.program.id,
            batchId: selection.batch.id, semesterId: selection.semester.id, sectionId: selection.section.id,
            subjectId: requirement.subject.id,
            subject: requirement.subject.name, code: requirement.subject.code,
            facultyId: facultyMember.id, roomId: room.id,
            day: slot.day, timeSlotId: slot.id, start: slot.start, end: slot.end,
            classType: requirement.classType, cohort,
            status: 'Draft', createdBy: user.id,
          }
          const candidateConflicts = evaluateCandidate(requirement, slot, facultyMember, room)
          if (candidateConflicts.length) {
            for (const item of candidateConflicts) addConflict(resourceConflicts, item)
          } else {
            assignments.push({ entry, duration })
          }
        }
      }
    }
    return assignments
  }

  async function search() {
    if (requirements.every((item) => item.remainingMinutes === 0)) return true
    if (searchLimitExceeded) return false

    let selectedRequirement = null
    let selectedAssignments = null
    for (const requirement of requirements) {
      if (requirement.remainingMinutes <= 0) continue
      const assignments = getValidAssignments(requirement)
      if (!assignments.length) return false
      if (!selectedAssignments || assignments.length < selectedAssignments.length) {
        selectedRequirement = requirement
        selectedAssignments = assignments
      }
    }
    if (!selectedRequirement || !selectedAssignments) return false

    for (const assignment of selectedAssignments) {
      selectedRequirement.remainingMinutes -= assignment.duration
      generatedEntries.push(assignment.entry)
      if (await search()) return true
      generatedEntries.pop()
      selectedRequirement.remainingMinutes += assignment.duration
      if (searchLimitExceeded) return false
    }
    return false
  }

  const completed = await search()
  if (!completed) {
    if (searchLimitExceeded) addConflict(resourceConflicts, conflict('GENERATION_SEARCH_LIMIT', 'Generation reached its deterministic search limit before finding a complete timetable.'))
    if (!resourceConflicts.length) {
      addConflict(resourceConflicts, conflict('INSUFFICIENT_AVAILABLE_SLOTS', 'The available class periods cannot satisfy all required weekly subject hours.'))
    }
    return { generated: false, conflicts: resourceConflicts.slice(0, 20) }
  }

  const validation = await validateManualTimetable(database, user, input, { entries: generatedEntries })
  if (!validation.valid) return { generated: false, conflicts: validation.conflicts }

  const savedIds = []
  try {
    for (const entry of generatedEntries) savedIds.push(await insertRecord(database, 'schedules', entry))
  } catch (error) {
    if (savedIds.length) await database.collection('schedules').deleteMany({ id: { $in: savedIds } })
    throw error
  }

  await writeAudit(database, {
    actorId: user.id, actorName: user.name, action: 'Generated draft timetable',
    target: `${selection.department.name} · ${selection.section.name}`,
    details: `${generatedEntries.length} draft entries generated using deterministic constraint-based scheduling`,
  })
  return {
    generated: true, count: generatedEntries.length, validation: { valid: true, conflicts: [] },
    entries: savedIds.map((id, index) => ({ id, ...generatedEntries[index] })),
  }
}
