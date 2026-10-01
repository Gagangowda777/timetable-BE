import { HttpError } from './httpError.js'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function minutes(time) {
  if (typeof time !== 'string' || !timePattern.test(time)) return Number.NaN
  const [hours, mins] = time.split(':').map(Number)
  return hours * 60 + mins
}

function duration(start, end) {
  return minutes(end) - minutes(start)
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatPeriod(entry) {
  return `${entry.day} ${entry.start}-${entry.end}`
}

async function getSectionStudentCount(database, candidate, section) {
  if (Number.isSafeInteger(section?.studentCount) && section.studentCount >= 0) return section.studentCount
  if (section?.id) {
    const assignedCount = await database.collection('users').countDocuments({
      role: 'student', status: 'Active', sectionId: section.id,
    })
    if (assignedCount) return assignedCount
  }
  const cohortFilter = { role: 'student', status: 'Active' }
  if (candidate.cohort) cohortFilter.cohort = candidate.cohort
  else if (section?.code) cohortFilter.cohort = new RegExp(`(?:^|[\\s·])${escapeRegex(section.code)}$`, 'i')
  else return 0
  if (candidate.programId) cohortFilter.programId = candidate.programId
  return database.collection('users').countDocuments(cohortFilter)
}

export async function validateTimetableEntry(database, candidate, { excludeEntryId, additionalEntries = [] } = {}) {
  const conflicts = []
  const conflictKeys = new Set()
  const addConflict = (type, message, existingEntryId = null) => {
    const key = `${type}:${existingEntryId ?? ''}`
    if (conflictKeys.has(key)) return
    conflictKeys.add(key)
    conflicts.push({ type, message, ...(existingEntryId == null ? {} : { existingEntryId }) })
  }

  if (!weekdays.includes(candidate.day) || !Number.isFinite(minutes(candidate.start))
    || !Number.isFinite(minutes(candidate.end)) || minutes(candidate.start) >= minutes(candidate.end)) {
    addConflict('INVALID_TIME_RANGE', 'Choose a valid day and a start time before the end time.')
    return { conflict: true, type: conflicts[0].type, message: conflicts[0].message, conflicts }
  }

  const [faculty, room, section, subject] = await Promise.all([
    candidate.faculty || !candidate.facultyId
      ? Promise.resolve(candidate.faculty)
      : database.collection('users').findOne({ id: candidate.facultyId, role: 'faculty' }),
    candidate.room || !candidate.roomId
      ? Promise.resolve(candidate.room)
      : database.collection('rooms').findOne({ id: candidate.roomId }),
    candidate.section || !candidate.sectionId
      ? Promise.resolve(candidate.section)
      : database.collection('sections').findOne({ id: candidate.sectionId }),
    candidate.subject || (!candidate.subjectId && !candidate.code)
      ? Promise.resolve(candidate.subject)
      : database.collection('subjects').findOne(candidate.subjectId
        ? { id: candidate.subjectId }
        : { code: candidate.code, departmentId: candidate.departmentId }),
  ])
  const candidateSectionId = candidate.sectionId ?? section?.id

  const start = minutes(candidate.start)
  const end = minutes(candidate.end)
  const workingDay = await database.collection('working_days').findOne({ day: candidate.day, enabled: true })
  if (!workingDay) addConflict('NON_WORKING_DAY', `${candidate.day} is not configured as a working day.`)
  const nonClassSlots = await database.collection('time_slots').find({
    day: candidate.day, type: { $in: ['BREAK', 'LUNCH'] }, status: 'Active',
  }).toArray()
  for (const slot of nonClassSlots) {
    if (overlaps(start, end, minutes(slot.start), minutes(slot.end))) {
      addConflict('NON_CLASS_TIME_SLOT', `Classes cannot be scheduled during the configured ${slot.type.toLowerCase()} period ${formatPeriod({ ...slot, day: candidate.day })}.`, slot.id)
    }
  }
  const overlapFilter = {
    day: candidate.day, start: { $lt: candidate.end }, end: { $gt: candidate.start },
    ...(excludeEntryId == null ? {} : { id: { $ne: Number(excludeEntryId) } }),
  }
  const persistedEntries = await database.collection('schedules').find(overlapFilter).toArray()
  const proposedOverlaps = additionalEntries.filter((entry) => (
    entry.day === candidate.day && entry.start < candidate.end && entry.end > candidate.start
  ))
  const existingEntries = [...persistedEntries, ...proposedOverlaps]
  for (const existing of existingEntries) {
    if (existing.status === 'Archived') continue
    if (candidate.versionId && existing.versionId && existing.versionId !== candidate.versionId
      && candidateSectionId && existing.sectionId === candidateSectionId) continue
    if (faculty && existing.facultyId === faculty.id) {
      addConflict('FACULTY_CONFLICT', `${faculty.name} is already assigned during ${formatPeriod(candidate)}.`, existing.id)
    }
    if (room && existing.roomId === room.id) {
      const isLab = room.type?.toLowerCase().includes('lab')
      addConflict(
        isLab ? 'LAB_CONFLICT' : 'ROOM_CONFLICT',
        `${isLab ? 'Laboratory' : 'Room'} ${room.name} is already assigned during ${formatPeriod(candidate)}.`,
        existing.id,
      )
    }
    const sameSection = section && (existing.sectionId === section.id
      || (candidate.cohort && existing.cohort === candidate.cohort))
      || !section && candidate.cohort && existing.cohort === candidate.cohort
        && (!candidate.programId || existing.programId === candidate.programId)
    if (sameSection) {
      addConflict('SECTION_CONFLICT', `${section?.name || candidate.cohort || 'Section'} already has a class during ${formatPeriod(candidate)}.`, existing.id)
    }
  }

  if (faculty) {
    const unavailableSlots = Array.isArray(faculty.unavailableSlots) ? faculty.unavailableSlots : []
    const legacyDays = String(faculty.availabilityDays || '').split(',').map((day) => day.trim()).filter(Boolean)
    const unavailableSlot = unavailableSlots.find((slot) => slot.day === candidate.day
      && overlaps(start, end, minutes(slot.start), minutes(slot.end)))
    if (faculty.available === false || (legacyDays.length && !legacyDays.includes(candidate.day)) || unavailableSlot) {
      addConflict('FACULTY_UNAVAILABLE', `${faculty.name} is unavailable during ${formatPeriod(candidate)}.`)
    }
  }

  if (room && (section || candidate.cohort) && Number.isFinite(Number(room.capacity))) {
    const studentCount = await getSectionStudentCount(database, candidate, section)
    if (Number(room.capacity) < studentCount) {
      addConflict('ROOM_CAPACITY', `${room.name} holds ${room.capacity} students, but ${section?.name || candidate.cohort} has ${studentCount}.`)
    }
  }

  if (subject && Number.isFinite(Number(subject.weeklyHours)) && Number(subject.weeklyHours) > 0) {
    const subjectMatch = subject.id
      ? { $or: [{ subjectId: subject.id }, { subjectId: { $exists: false }, code: subject.code, departmentId: candidate.departmentId }] }
      : { code: subject.code, departmentId: candidate.departmentId }
    const sectionMatch = candidateSectionId
      ? { sectionId: candidateSectionId }
      : candidate.cohort ? { cohort: candidate.cohort } : {}
    const versionMatch = candidate.versionId ? { versionId: candidate.versionId } : {}
    const subjectFilter = { $and: [subjectMatch, sectionMatch, versionMatch] }
    if (excludeEntryId != null) subjectFilter.id = { $ne: Number(excludeEntryId) }
    const persistedAllocations = await database.collection('schedules').find(subjectFilter).toArray()
    const proposedAllocations = additionalEntries.filter((entry) => (
      (entry.subjectId === subject.id || (!entry.subjectId && entry.code === subject.code && entry.departmentId === candidate.departmentId))
      && (!candidate.versionId || entry.versionId === candidate.versionId)
      && (!candidateSectionId || entry.sectionId === candidateSectionId)
      && (!candidate.cohort || entry.cohort === candidate.cohort)
    ))
    const allocatedEntries = [...persistedAllocations, ...proposedAllocations]
    const allocatedMinutes = allocatedEntries.reduce((total, entry) => total + Math.max(0, duration(entry.start, entry.end)), 0)
    const newTotal = allocatedMinutes + duration(candidate.start, candidate.end)
    if (newTotal > Number(subject.weeklyHours) * 60) {
      addConflict('WEEKLY_SUBJECT_HOURS', `${subject.name} would exceed its configured ${subject.weeklyHours} weekly hours.`)
    } else {
      const typeHours = candidate.classType === 'LAB' ? subject.practicalHours : subject.theoryHours
      if (Number.isFinite(Number(typeHours)) && Number(typeHours) >= 0 && candidate.classType) {
        const allocatedTypeMinutes = allocatedEntries
          .filter((entry) => entry.classType === candidate.classType)
          .reduce((total, entry) => total + Math.max(0, duration(entry.start, entry.end)), 0)
        if (allocatedTypeMinutes + duration(candidate.start, candidate.end) > Number(typeHours) * 60) {
          addConflict('WEEKLY_SUBJECT_HOURS', `${subject.name} would exceed its configured ${candidate.classType === 'LAB' ? 'practical' : 'theory'} hours.`)
        }
      }
    }
  }

  return conflicts.length
    ? { conflict: true, type: conflicts[0].type, message: conflicts[0].message, conflicts }
    : { conflict: false, type: null, message: '', conflicts: [] }
}

export async function assertTimetableEntryHasNoConflicts(database, candidate, options) {
  const result = await validateTimetableEntry(database, candidate, options)
  if (result.conflict) throw new HttpError(409, result.message, result)
  return result
}