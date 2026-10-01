import { getEditableManualVersion, getManualSelection, validateManualTimetable } from '../models/adminModel.js'
import { writeAudit } from '../models/auditModel.js'
import { insertRecord } from '../models/dataHelpers.js'
import { validateTimetableEntry } from '../utils/timetableConflictService.js'

const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const maxAssignmentChecks = 20000

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

function hasRequiredAcademicRelationship(subject, selection) {
  return subject.academicYearId === selection.academicYear.id
    && subject.departmentId === selection.department.id
    && subject.programId === selection.program.id
    && subject.batchId === selection.batch.id
    && subject.semesterId === selection.semester.id
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

  const [subjects, faculty, rooms, workingDays, timeSlots] = await Promise.all([
    database.collection('subjects').find({
      status: 'Active', academicYearId: selection.academicYear.id,
      departmentId: selection.department.id, programId: selection.program.id,
      batchId: selection.batch.id, semesterId: selection.semester.id,
    }).sort({ code: 1 }).toArray(),
    database.collection('users').find({ role: 'faculty', status: 'Active', departmentId: selection.department.id }).sort({ name: 1 }).toArray(),
    database.collection('rooms').find({ status: 'Active', campusId: selection.department.campusId }).sort({ name: 1 }).toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
    database.collection('time_slots').find({ type: 'CLASS', status: 'Active' }).toArray(),
  ])
  const conflicts = []
  if (!subjects.length) conflicts.push(conflict('NO_SUBJECTS', 'No active subjects are configured for the selected academic structure.'))
  if (!workingDays.length) conflicts.push(conflict('NO_WORKING_DAYS', 'No working days are enabled.'))
  const workdayNames = new Set(workingDays.map((day) => day.day))
  const possibleSlots = timeSlots.filter((slot) => workdayNames.has(slot.day))
    .sort((left, right) => dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day)
      || left.start.localeCompare(right.start) || left.sequence - right.sequence)
  if (!possibleSlots.length) conflicts.push(conflict('NO_CLASS_SLOTS', 'No active CLASS time slots are available on enabled working days.'))

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

  const cohort = `${selection.batch.name} · ${selection.section.name}`
  const generatedEntries = []
  let assignmentChecks = 0
  let searchLimitExceeded = false
  const resourceConflicts = []

  async function getValidAssignments(requirement) {
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
            batchId: selection.batch.id, semesterId: selection.semester.id,
            sectionId: selection.section.id, subjectId: requirement.subject.id,
            subject: requirement.subject.name, code: requirement.subject.code,
            facultyId: facultyMember.id, roomId: room.id,
            day: slot.day, timeSlotId: slot.id, start: slot.start, end: slot.end,
            classType: requirement.classType, cohort,
            status: 'Draft', createdBy: user.id,
          }
          const result = await validateTimetableEntry(database, {
            ...entry, subject: requirement.subject, faculty: facultyMember,
            room, section: selection.section,
          }, { additionalEntries: generatedEntries })
          if (result.conflict) {
            for (const item of result.conflicts) addConflict(resourceConflicts, item)
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
      const assignments = await getValidAssignments(requirement)
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