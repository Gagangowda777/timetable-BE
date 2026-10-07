import { HttpError } from '../utils/httpError.js'
import { writeAudit } from './auditModel.js'
import { byId, insertRecord, sortByDayAndTime, sortByName } from './dataHelpers.js'
import { notifyStudentsOfPublishedSchedules } from './notificationsModel.js'
import { assertTimetableEntryHasNoConflicts, validateTimetableEntry } from '../utils/timetableConflictService.js'

const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const slotTypes = new Set(['CLASS', 'BREAK', 'LUNCH'])
const slotStatuses = new Set(['Active', 'Inactive'])
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const classTypes = new Set(['LECTURE', 'LAB'])

export async function getAdminBootstrap(database, user, requestedDepartmentId) {
  const departmentFilter = user.role === 'department-admin'
    ? { id: user.departmentId }
    : requestedDepartmentId ? { id: Number(requestedDepartmentId) } : {}
  const departments = sortByName(await database.collection('departments').find(departmentFilter).toArray())
  const departmentIds = user.role === 'department-admin'
    ? [user.departmentId]
    : requestedDepartmentId ? [Number(requestedDepartmentId)] : departments.map((item) => item.id)
  if (!departmentIds.length) return { departments, rooms: [], schedules: [], faculty: [], conflicts: [], workingDays: [], timeSlots: [] }

  const [campuses, schedulesRaw, facultyRaw, conflictsRaw, workingDaysRaw, timeSlotsRaw] = await Promise.all([
    database.collection('campuses').find({ id: { $in: departments.map((item) => item.campusId).filter(Boolean) } }).toArray(),
    database.collection('schedules').find({ departmentId: { $in: departmentIds } }).toArray(),
    database.collection('users').find({ role: 'faculty', status: 'Active', departmentId: { $in: departmentIds } }).toArray(),
    database.collection('conflicts').find(user.role === 'department-admin'
      ? { departmentId: user.departmentId, isCrossDepartment: false }
      : departmentIds.length === departments.length && !requestedDepartmentId
        ? {}
        : { $or: [{ isCrossDepartment: true }, { departmentId: { $in: departmentIds } }] }).sort({ id: -1 }).toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
    database.collection('time_slots').find().sort({ start: 1 }).toArray(),
  ])
  const [rooms, allFaculty, allDepartments] = await Promise.all([
    database.collection('rooms').find({ status: 'Active', campusId: { $in: departments.map((item) => item.campusId).filter(Boolean) } }).toArray(),
    database.collection('users').find({ id: { $in: [...new Set([
      ...schedulesRaw.flatMap((item) => [item.facultyId, item.submittedBy, item.reviewedBy, item.approvedBy]),
      ...facultyRaw.map((item) => item.id),
    ].filter((id) => id != null))] } }).toArray(),
    database.collection('departments').find({ id: { $in: departmentIds } }).toArray(),
  ])
  const scheduleRoomDocs = await database.collection('rooms').find({ id: { $in: schedulesRaw.map((item) => item.roomId) } }).toArray()
  const campusesById = new Map(campuses.map((item) => [item.id, item]))
  const facultyById = new Map(allFaculty.map((item) => [item.id, item]))
  const departmentById = new Map(allDepartments.map((item) => [item.id, item]))
  const roomById = new Map([...rooms, ...scheduleRoomDocs].map((item) => [item.id, item]))
  const schedules = sortByDayAndTime(schedulesRaw.map((item) => ({
    id: item.id, departmentId: item.departmentId, department: departmentById.get(item.departmentId)?.name,
    day: item.day, start: item.start, end: item.end, subject: item.subject, code: item.code,
    facultyId: item.facultyId, faculty: facultyById.get(item.facultyId)?.name,
    roomId: item.roomId, room: roomById.get(item.roomId)?.name, group: item.cohort, status: item.status,
    submittedBy: facultyById.get(item.submittedBy)?.name || null, submittedAt: item.submittedAt || null,
    reviewedBy: facultyById.get(item.reviewedBy)?.name || null, reviewedAt: item.reviewedAt || null,
    approvedBy: facultyById.get(item.approvedBy)?.name || null, approvedAt: item.approvedAt || null,
    rejectionReason: item.rejectionReason || '', reviewComments: item.reviewComments || '',
  })))
  const faculty = sortByName(facultyRaw.map((item) => ({
    id: item.id, name: item.name, department: departmentById.get(item.departmentId)?.name,
    days: item.availabilityDays, available: Boolean(item.available),
  })))
  const campusNames = new Map(campuses.map((item) => [item.id, item.name]))
  const roomList = sortByName(rooms.map((item) => ({ id: item.id, name: item.name, campus: campusNames.get(item.campusId) })))
  const conflictDepartmentIds = conflictsRaw.map((item) => item.departmentId).filter(Boolean)
  const conflictDepartments = await database.collection('departments').find({ id: { $in: conflictDepartmentIds } }).toArray()
  const conflictDepartmentById = new Map(conflictDepartments.map((item) => [item.id, item]))
  const conflicts = conflictsRaw.map((item) => ({
    id: item.id, type: item.type, day: item.day, start: item.start, end: item.end, detail: item.detail,
    schedules: item.schedules, department: item.isCrossDepartment ? 'Cross-department' : conflictDepartmentById.get(item.departmentId)?.name,
    isCrossDepartment: Boolean(item.isCrossDepartment), status: item.status, time: `${item.start}–${item.end}`,
  }))
  return {
    departments: departments.map((item) => ({ ...item, campus: campusesById.get(item.campusId)?.name })),
    rooms: roomList, schedules, faculty, conflicts,
    workingDays: workingDaysRaw.map((item) => item.day),
    timeSlots: sortCalendarSlots(timeSlotsRaw),
  }
}

export async function createDepartmentSchedule(database, user, input) {
  const departmentId = user.role === 'department-admin' ? user.departmentId : Number(input.departmentId)
  const [department, faculty, room] = await Promise.all([
    database.collection('departments').findOne({ id: departmentId, status: 'Active' }),
    database.collection('users').findOne({ id: Number(input.facultyId), role: 'faculty', status: 'Active' }),
    database.collection('rooms').findOne({ id: Number(input.roomId), status: 'Active' }),
  ])
  if (!department) throw new HttpError(400, 'Choose an active department.')
  if (!faculty || !room) throw new HttpError(400, 'Choose an active faculty member and room.')
  if (user.role === 'department-admin' && faculty.departmentId !== department.id) throw new HttpError(400, 'Choose a faculty member in your department.')
  const required = ['day', 'start', 'end', 'subject', 'code']
  if (required.some((key) => typeof input[key] !== 'string' || !input[key].trim())) throw new HttpError(400, 'Complete all timetable fields.')
  const subject = input.subject.trim()
  const subjectRecord = await database.collection('subjects').findOne({ code: input.code.trim(), departmentId })
  const section = input.sectionId
    ? await database.collection('sections').findOne({ id: Number(input.sectionId) })
    : null
  await assertTimetableEntryHasNoConflicts(database, {
    departmentId, programId: input.programId ? Number(input.programId) : null,
    facultyId: faculty.id, faculty, roomId: room.id, room,
    subjectId: subjectRecord?.id, subject: subjectRecord, code: input.code.trim(),
    sectionId: section?.id, section, cohort: input.group?.trim() || '',
    day: input.day, start: input.start, end: input.end, classType: input.classType || 'LECTURE',
  })
  const scheduleId = await insertRecord(database, 'schedules', {
    departmentId, programId: input.programId ? Number(input.programId) : null,
    sectionId: section?.id, subjectId: subjectRecord?.id,
    day: input.day, start: input.start, end: input.end,
    subject, code: input.code.trim(), facultyId: faculty.id, roomId: room.id,
    cohort: input.group || '', classType: input.classType || 'LECTURE', status: 'Draft', createdBy: user.id,
  })
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Created timetable entry', target: subject, details: department.name })
  return { id: scheduleId, conflictsCreated: 0 }
}

function optionalFilterId(input, field) {
  if (input[field] === undefined || input[field] === '') return null
  const id = Number(input[field])
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, `Choose a valid ${field.replace('Id', '').toLowerCase()}.`)
  return id
}

export async function getManualSelection(database, user, input) {
  const academicYearId = optionalFilterId(input, 'academicYearId')
  const departmentId = optionalFilterId(input, 'departmentId')
  const programId = optionalFilterId(input, 'programId')
  const batchId = optionalFilterId(input, 'batchId')
  const semesterId = optionalFilterId(input, 'semesterId')
  const sectionId = optionalFilterId(input, 'sectionId')
  if ([academicYearId, departmentId, programId, batchId, semesterId, sectionId].some((id) => id === null)) {
    throw new HttpError(400, 'Choose an academic year, department, program, batch, semester, and section.')
  }
  if (user.role === 'department-admin' && departmentId !== user.departmentId) {
    throw new HttpError(403, 'You can manage timetable entries only in your department.')
  }
  const [academicYear, department, program, batch, semester, section] = await Promise.all([
    database.collection('academic_years').findOne({ id: academicYearId, status: 'Active' }),
    database.collection('departments').findOne({ id: departmentId, status: 'Active' }),
    database.collection('programs').findOne({ id: programId, status: 'Active' }),
    database.collection('batches').findOne({ id: batchId, status: 'Active' }),
    database.collection('semesters').findOne({ id: semesterId, status: 'Active' }),
    database.collection('sections').findOne({ id: sectionId, status: 'Active' }),
  ])
  if (!academicYear || !department || !program || !batch || !semester || !section) {
    throw new HttpError(400, 'Choose active academic structure records.')
  }
  if (!(department.academicYearIds || []).includes(academicYear.id)
    || program.departmentId !== department.id
    || batch.academicYearId !== academicYear.id || batch.departmentId !== department.id || batch.programId !== program.id
    || semester.batchId !== batch.id || section.semesterId !== semester.id) {
    throw new HttpError(400, 'The selected academic year, department, program, batch, semester, and section do not match.')
  }
  return { academicYear, department, program, batch, semester, section }
}

function manualVersionScope(selection) {
  return {
    academicYearId: selection.academicYear.id, departmentId: selection.department.id,
    programId: selection.program.id, batchId: selection.batch.id,
    semesterId: selection.semester.id, sectionId: selection.section.id,
  }
}

async function ensureManualTimetableVersion(database, user, input) {
  const selection = await getManualSelection(database, user, input)
  const scope = manualVersionScope(selection)
  let versions = await database.collection('timetable_versions').find(scope).sort({ versionNumber: -1 }).toArray()
  if (versions.length) return { selection, scope, versions }

  const legacyEntries = await database.collection('schedules').find({
    ...scope, entrySource: 'manual', versionId: { $exists: false },
  }).toArray()
  const statuses = [...new Set(legacyEntries.map((entry) => entry.status))]
  const status = statuses.length === 1 ? statuses[0] : statuses.includes('Published') ? 'Published' : 'Draft'
  const versionNumber = 1
  const id = await insertRecord(database, 'timetable_versions', {
    ...scope, versionNumber, status, createdBy: user.id,
    publishedAt: status === 'Published' ? new Date() : null,
    submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null,
    approvedBy: null, approvedAt: null, rejectionReason: '', reviewComments: '',
  })
  if (legacyEntries.length) {
    await database.collection('schedules').updateMany(
      { id: { $in: legacyEntries.map((entry) => entry.id) } },
      { $set: { versionId: id, versionNumber } },
    )
  }
  versions = await database.collection('timetable_versions').find(scope).sort({ versionNumber: -1 }).toArray()
  return { selection, scope, versions }
}

export async function getManualTimetableVersions(database, user, input) {
  const { scope, versions } = await ensureManualTimetableVersion(database, user, input)
  const entryCounts = await Promise.all(versions.map((version) => database.collection('schedules').countDocuments({ versionId: version.id })))
  const listed = versions.map((version, index) => ({
    id: version.id, versionNumber: version.versionNumber, status: version.status,
    createdBy: version.createdBy, createdAt: version.createdAt,
    submittedBy: version.submittedBy ?? null, submittedAt: version.submittedAt ?? null,
    reviewedBy: version.reviewedBy ?? null, reviewedAt: version.reviewedAt ?? null,
    approvedBy: version.approvedBy ?? null, approvedAt: version.approvedAt ?? null,
    publishedAt: version.publishedAt ?? null, rejectionReason: version.rejectionReason || '',
    reviewComments: version.reviewComments || '', basedOnVersionId: version.basedOnVersionId ?? null,
    entryCount: entryCounts[index],
  }))
  return {
    versions: listed,
    currentPublishedVersionId: listed.find((version) => version.status === 'Published')?.id ?? null,
    currentDraftVersionId: listed.find((version) => version.status === 'Draft')?.id ?? null,
  }
}

export async function createManualTimetableVersion(database, user, input) {
  const { scope, versions } = await ensureManualTimetableVersion(database, user, input)
  const draft = versions.find((version) => version.status === 'Draft')
  if (draft) throw new HttpError(409, `Version ${draft.versionNumber} is already in Draft. Edit that version before creating another.`)
  const published = versions.find((version) => version.status === 'Published')
  if (!published) throw new HttpError(409, 'A new version can be created only from a published timetable.')
  if (versions[0].id !== published.id) {
    throw new HttpError(409, 'Resolve the latest timetable version before creating another revision.')
  }

  const versionNumber = Math.max(...versions.map((version) => version.versionNumber)) + 1
  const id = await insertRecord(database, 'timetable_versions', {
    ...scope, versionNumber, status: 'Draft', basedOnVersionId: published.id,
    createdBy: user.id, submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null,
    approvedBy: null, approvedAt: null, publishedAt: null, rejectionReason: '', reviewComments: '',
  })
  const sourceEntries = await database.collection('schedules').find({ versionId: published.id }).toArray()
  for (const entry of sourceEntries) {
    const { _id, id: previousId, createdAt, submittedBy, submittedAt, reviewedBy, reviewedAt, approvedBy, approvedAt, rejectionReason, reviewComments, publishedAt, ...copy } = entry
    await insertRecord(database, 'schedules', {
      ...copy, versionId: id, versionNumber, status: 'Draft', createdBy: user.id,
      submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null,
      approvedBy: null, approvedAt: null, rejectionReason: '', reviewComments: '', publishedAt: null,
    })
  }
  const [version] = await database.collection('timetable_versions').find({ id }).toArray()
  return { version: { id: version.id, versionNumber, status: version.status, basedOnVersionId: published.id } }
}

export async function getEditableManualVersion(database, user, input, selection) {
  const scope = manualVersionScope(selection)
  const requestedVersionId = input.versionId === undefined || input.versionId === '' ? null : Number(input.versionId)
  let version
  if (requestedVersionId) {
    version = await database.collection('timetable_versions').findOne({ ...scope, id: requestedVersionId })
  } else {
    const versions = await ensureManualTimetableVersion(database, user, input)
    version = versions.versions.find((item) => item.status === 'Draft')
    if (!version && versions.versions.length) {
      throw new HttpError(409, 'There is no editable Draft version. Create a new version from the current published timetable.')
    }
  }
  if (!version) throw new HttpError(404, 'Timetable version not found.')
  if (version.status !== 'Draft') throw new HttpError(409, 'Only Draft timetable versions can be modified. Create a new version from the published timetable.')
  return version
}

export async function getManualTimetableOptions(database, user, filters = {}) {
  const academicYearId = optionalFilterId(filters, 'academicYearId')
  let departmentId = optionalFilterId(filters, 'departmentId')
  const programId = optionalFilterId(filters, 'programId')
  const batchId = optionalFilterId(filters, 'batchId')
  const semesterId = optionalFilterId(filters, 'semesterId')
  if (user.role === 'department-admin') {
    if (departmentId && departmentId !== user.departmentId) throw new HttpError(403, 'You can manage timetable entries only in your department.')
    departmentId = user.departmentId
  }

  const departmentFilter = { status: 'Active' }
  if (departmentId) departmentFilter.id = departmentId
  if (user.role === 'department-admin') departmentFilter.id = user.departmentId
  const departments = await database.collection('departments').find(departmentFilter).sort({ name: 1 }).toArray()
  const departmentIds = departments.map((department) => department.id)
  const [academicYears, programs, batches, semesters, sections, workingDays] = await Promise.all([
    database.collection('academic_years').find({ status: 'Active' }).sort({ name: -1 }).toArray(),
    database.collection('programs').find({ status: 'Active', departmentId: { $in: departmentIds }, ...(departmentId ? { departmentId } : {}) }).sort({ name: 1 }).toArray(),
    database.collection('batches').find({
      status: 'Active', departmentId: { $in: departmentIds },
      ...(academicYearId ? { academicYearId } : {}), ...(programId ? { programId } : {}), ...(batchId ? { id: batchId } : {}),
    }).sort({ name: 1 }).toArray(),
    database.collection('semesters').find({ status: 'Active', ...(batchId ? { batchId } : {}) }).sort({ name: 1 }).toArray(),
    database.collection('sections').find({ status: 'Active', ...(semesterId ? { semesterId } : {}) }).sort({ name: 1 }).toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
  ])
  const [subjects, faculty, rooms, allTimeSlots] = await Promise.all([
    database.collection('subjects').find({ status: 'Active', departmentId: { $in: departmentIds },
      ...(academicYearId ? { academicYearId } : {}), ...(programId ? { programId } : {}),
      ...(batchId ? { batchId } : {}), ...(semesterId ? { semesterId } : {}),
    }).sort({ name: 1 }).toArray(),
    database.collection('users').find({ role: 'faculty', status: 'Active', departmentId: { $in: departmentIds } }).sort({ name: 1 }).toArray(),
    database.collection('rooms').find({ status: 'Active', campusId: { $in: departments.map((department) => department.campusId).filter(Boolean) } }).sort({ name: 1 }).toArray(),
    database.collection('time_slots').find({ status: 'Active' }).toArray(),
  ])
  const timeSlots = sortCalendarSlots(allTimeSlots.filter((slot) => workingDays.some((item) => item.day === slot.day)))
  return {
    academicYears: academicYears.map(({ id, name }) => ({ id, name })),
    departments: departments.map(({ id, name, campusId, academicYearIds }) => ({ id, name, campusId, academicYearIds: academicYearIds || [] })),
    programs: programs.map(({ id, name, departmentId: ownerDepartmentId }) => ({ id, name, departmentId: ownerDepartmentId })),
    batches: batches.map(({ id, name, code, academicYearId: yearId, departmentId: ownerDepartmentId, programId: ownerProgramId }) => ({
      id, name, code, academicYearId: yearId, departmentId: ownerDepartmentId, programId: ownerProgramId,
    })),
    semesters: semesters.map(({ id, name, batchId: ownerBatchId }) => ({ id, name, batchId: ownerBatchId })),
    sections: sections.map(({ id, name, code, semesterId: ownerSemesterId }) => ({ id, name, code, semesterId: ownerSemesterId })),
    subjects: subjects.map(({ id, name, code, requiresLab, academicYearId: yearId, departmentId: ownerDepartmentId, programId: ownerProgramId, batchId: ownerBatchId, semesterId: ownerSemesterId }) => ({
      id, name, code, requiresLab: Boolean(requiresLab), academicYearId: yearId,
      departmentId: ownerDepartmentId, programId: ownerProgramId, batchId: ownerBatchId, semesterId: ownerSemesterId,
    })),
    faculty: faculty.map(({ id, name, departmentId: ownerDepartmentId }) => ({ id, name, departmentId: ownerDepartmentId })),
    rooms: rooms.map(({ id, name, code, type, campusId }) => ({ id, name, code, type, campusId })),
    labs: rooms.filter((room) => room.type.toLowerCase().includes('lab')).map(({ id, name, code, type, campusId }) => ({ id, name, code, type, campusId })),
    workingDays: workingDays.map(({ day }) => day), timeSlots,
  }
}

async function validateManualEntry(database, user, input) {
  const selection = await getManualSelection(database, user, input)
  const version = await getEditableManualVersion(database, user, input, selection)
  const subjectId = optionalFilterId(input, 'subjectId')
  const facultyId = optionalFilterId(input, 'facultyId')
  const roomId = optionalFilterId(input, 'roomId')
  const timeSlotId = optionalFilterId(input, 'timeSlotId')
  if (!subjectId || !facultyId || !roomId || !timeSlotId) throw new HttpError(400, 'Choose a subject, faculty member, room, and time slot.')
  if (!classTypes.has(input.classType)) throw new HttpError(400, 'Class type must be LECTURE or LAB.')
  const [subject, faculty, room, timeSlot, workingDay] = await Promise.all([
    database.collection('subjects').findOne({
      id: subjectId, status: 'Active', academicYearId: selection.academicYear.id,
      departmentId: selection.department.id, programId: selection.program.id,
      batchId: selection.batch.id, semesterId: selection.semester.id,
    }),
    database.collection('users').findOne({ id: facultyId, role: 'faculty', status: 'Active', departmentId: selection.department.id }),
    database.collection('rooms').findOne({ id: roomId, status: 'Active', campusId: selection.department.campusId }),
    database.collection('time_slots').findOne({ id: timeSlotId, day: input.day, type: 'CLASS', status: 'Active' }),
    database.collection('working_days').findOne({ day: input.day, enabled: true }),
  ])
  if (!subject) throw new HttpError(400, 'Choose an active subject for the selected academic structure.')
  if (!faculty) throw new HttpError(400, 'Choose an active faculty member in the selected department.')
  if (!room) throw new HttpError(400, 'Choose an active room at the selected department campus.')
  if (input.classType === 'LAB' && !room.type.toLowerCase().includes('lab')) throw new HttpError(400, 'Choose a laboratory room for a lab class.')
  if (!timeSlot || !workingDay) throw new HttpError(400, 'Choose an active CLASS time slot on a working day.')
  return { ...selection, version, subject, faculty, room, timeSlot }
}

async function formatManualEntries(database, schedules) {
  const [subjects, faculty, rooms, sections] = await Promise.all([
    database.collection('subjects').find({ id: { $in: schedules.map((entry) => entry.subjectId) } }).toArray(),
    database.collection('users').find({ id: { $in: schedules.map((entry) => entry.facultyId) } }).toArray(),
    database.collection('rooms').find({ id: { $in: schedules.map((entry) => entry.roomId) } }).toArray(),
    database.collection('sections').find({ id: { $in: schedules.map((entry) => entry.sectionId) } }).toArray(),
  ])
  const subjectsById = new Map(subjects.map((item) => [item.id, item]))
  const facultyById = new Map(faculty.map((item) => [item.id, item]))
  const roomsById = new Map(rooms.map((item) => [item.id, item]))
  const sectionsById = new Map(sections.map((item) => [item.id, item]))
  return schedules.map((entry) => ({
    id: entry.id, versionId: entry.versionId, versionNumber: entry.versionNumber,
    academicYearId: entry.academicYearId, departmentId: entry.departmentId,
    programId: entry.programId, batchId: entry.batchId, semesterId: entry.semesterId,
    sectionId: entry.sectionId, section: sectionsById.get(entry.sectionId)?.name || '',
    subjectId: entry.subjectId, subject: subjectsById.get(entry.subjectId)?.name || entry.subject,
    code: subjectsById.get(entry.subjectId)?.code || entry.code,
    facultyId: entry.facultyId, faculty: facultyById.get(entry.facultyId)?.name || '',
    roomId: entry.roomId, room: roomsById.get(entry.roomId)?.name || '',
    day: entry.day, timeSlotId: entry.timeSlotId, start: entry.start, end: entry.end,
    classType: entry.classType, status: entry.status,
  }))
}

export async function listManualTimetableEntries(database, user, filters) {
  const selection = await getManualSelection(database, user, filters)
  const { versions } = await ensureManualTimetableVersion(database, user, filters)
  const requestedVersionId = filters.versionId ? Number(filters.versionId) : null
  const version = requestedVersionId
    ? versions.find((item) => item.id === requestedVersionId)
    : versions.find((item) => item.status === 'Draft') || versions.find((item) => item.status === 'Published')
  if (!version) throw new HttpError(404, 'Timetable version not found.')
  const schedules = await database.collection('schedules').find({
    entrySource: 'manual', versionId: version.id, academicYearId: selection.academicYear.id,
    departmentId: selection.department.id, programId: selection.program.id,
    batchId: selection.batch.id, semesterId: selection.semester.id, sectionId: selection.section.id,
  }).sort({ day: 1, start: 1 }).toArray()
  return { entries: await formatManualEntries(database, schedules) }
}

export async function createManualTimetableEntry(database, user, input) {
  const validated = await validateManualEntry(database, user, input)
  await assertTimetableEntryHasNoConflicts(database, {
    ...validated, versionId: validated.version.id, day: validated.timeSlot.day, start: validated.timeSlot.start,
    end: validated.timeSlot.end, classType: input.classType,
    cohort: `${validated.batch.name} · ${validated.section.name}`,
  })
  const id = await insertRecord(database, 'schedules', {
    entrySource: 'manual', versionId: validated.version.id, versionNumber: validated.version.versionNumber,
    academicYearId: validated.academicYear.id,
    departmentId: validated.department.id, programId: validated.program.id,
    batchId: validated.batch.id, semesterId: validated.semester.id, sectionId: validated.section.id,
    subjectId: validated.subject.id, subject: validated.subject.name, code: validated.subject.code,
    facultyId: validated.faculty.id, roomId: validated.room.id,
    day: validated.timeSlot.day, timeSlotId: validated.timeSlot.id,
    start: validated.timeSlot.start, end: validated.timeSlot.end, classType: input.classType,
    cohort: `${validated.batch.name} · ${validated.section.name}`, status: 'Draft', createdBy: user.id,
  })
  const [entry] = await formatManualEntries(database, [await database.collection('schedules').findOne(byId(id))])
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Created manual timetable entry', target: entry.subject, details: `${entry.day} ${entry.start}-${entry.end} · ${entry.section}` })
  return { entry }
}

export async function updateManualTimetableEntry(database, user, id, input) {
  const current = await database.collection('schedules').findOne({ ...byId(id), entrySource: 'manual' })
  if (!current) throw new HttpError(404, 'Manual timetable entry not found.')
  if (user.role === 'department-admin' && current.departmentId !== user.departmentId) {
    throw new HttpError(403, 'You can manage timetable entries only in your department.')
  }
  const validated = await validateManualEntry(database, user, input)
  if (current.versionId !== validated.version.id) throw new HttpError(409, 'Entries can only be modified within their own Draft version.')
  await assertTimetableEntryHasNoConflicts(database, {
    ...validated, versionId: validated.version.id, day: validated.timeSlot.day, start: validated.timeSlot.start,
    end: validated.timeSlot.end, classType: input.classType,
    cohort: `${validated.batch.name} · ${validated.section.name}`,
  }, { excludeEntryId: current.id })
  await database.collection('schedules').updateOne(byId(current.id), { $set: {
    academicYearId: validated.academicYear.id, departmentId: validated.department.id,
    programId: validated.program.id, batchId: validated.batch.id, semesterId: validated.semester.id,
    sectionId: validated.section.id, subjectId: validated.subject.id,
    subject: validated.subject.name, code: validated.subject.code,
    facultyId: validated.faculty.id, roomId: validated.room.id,
    day: validated.timeSlot.day, timeSlotId: validated.timeSlot.id,
    start: validated.timeSlot.start, end: validated.timeSlot.end, classType: input.classType,
    cohort: `${validated.batch.name} · ${validated.section.name}`,
  } })
  const [entry] = await formatManualEntries(database, [await database.collection('schedules').findOne(byId(current.id))])
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Updated manual timetable entry', target: entry.subject, details: `${entry.day} ${entry.start}-${entry.end} · ${entry.section}` })
  return { entry }
}

export async function deleteManualTimetableEntry(database, user, id) {
  const entry = await database.collection('schedules').findOne({ ...byId(id), entrySource: 'manual' })
  if (!entry) throw new HttpError(404, 'Manual timetable entry not found.')
  if (user.role === 'department-admin' && entry.departmentId !== user.departmentId) {
    throw new HttpError(403, 'You can manage timetable entries only in your department.')
  }
  const version = await database.collection('timetable_versions').findOne({ id: entry.versionId })
  if (!version || version.status !== 'Draft') {
    throw new HttpError(409, 'Published and non-Draft timetable entries are read-only. Create a new version to modify them.')
  }
  await database.collection('schedules').deleteOne(byId(entry.id))
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Deleted manual timetable entry', target: entry.subject, details: `${entry.day} ${entry.start}-${entry.end}` })
  return { id: entry.id, deleted: true }
}

export async function validateManualTimetable(database, user, input, { entries: proposedEntries } = {}) {
  let selection
  try {
    selection = await getManualSelection(database, user, input)
  } catch (error) {
    if (error.status === 400) {
      return {
        valid: false,
        conflicts: [{ type: 'INVALID_ACADEMIC_RELATIONSHIP', message: error.message }],
      }
    }
    throw error
  }

  const { versions } = await ensureManualTimetableVersion(database, user, input)
  const requestedVersionId = input.versionId ? Number(input.versionId) : null
  const version = requestedVersionId
    ? versions.find((item) => item.id === requestedVersionId)
    : versions.find((item) => item.status === 'Draft') || versions.find((item) => item.status === 'Published')
  if (!version) return { valid: false, conflicts: [{ type: 'INVALID_ACADEMIC_RELATIONSHIP', message: 'Choose a valid timetable version.' }] }
  const [subjects, savedEntries] = await Promise.all([
    database.collection('subjects').find({
      status: 'Active', academicYearId: selection.academicYear.id,
      departmentId: selection.department.id, programId: selection.program.id,
      batchId: selection.batch.id, semesterId: selection.semester.id,
    }).toArray(),
    database.collection('schedules').find({
      entrySource: 'manual', versionId: version.id, academicYearId: selection.academicYear.id,
      departmentId: selection.department.id, programId: selection.program.id,
      batchId: selection.batch.id, semesterId: selection.semester.id, sectionId: selection.section.id,
    }).sort({ day: 1, start: 1 }).toArray(),
  ])
  const entries = proposedEntries || savedEntries
  const conflicts = []
  const conflictKeys = new Set()
  const addConflict = (type, message, entryId) => {
    const key = `${type}:${message}:${entryId ?? ''}`
    if (conflictKeys.has(key)) return
    conflictKeys.add(key)
    conflicts.push({ type, message, ...(entryId == null ? {} : { entryId }) })
  }

  if (!entries.length) addConflict('MISSING_REQUIRED_ASSIGNMENT', `No timetable entries are assigned to ${selection.section.name}.`)
  for (const [entryIndex, entry] of entries.entries()) {
    const missing = ['subjectId', 'facultyId', 'roomId', 'sectionId', 'timeSlotId', 'day', 'start', 'end', 'classType']
      .filter((field) => entry[field] === undefined || entry[field] === null || entry[field] === '')
    if (missing.length) {
      addConflict('MISSING_REQUIRED_ASSIGNMENT', `Entry ${entry.id} is missing ${missing.join(', ')}.`, entry.id)
      continue
    }

    const [subject, faculty, room, timeSlot] = await Promise.all([
      database.collection('subjects').findOne({ id: entry.subjectId, status: 'Active' }),
      database.collection('users').findOne({ id: entry.facultyId, role: 'faculty', status: 'Active' }),
      database.collection('rooms').findOne({ id: entry.roomId, status: 'Active' }),
      database.collection('time_slots').findOne({ id: entry.timeSlotId, status: 'Active' }),
    ])
    if (!subject || !faculty || !room || !timeSlot) {
      addConflict('INVALID_ACADEMIC_RELATIONSHIP', `Entry ${entry.id} references an inactive or missing subject, faculty member, room, or time slot.`, entry.id)
      continue
    }
    const validRelations = entry.academicYearId === selection.academicYear.id
      && entry.departmentId === selection.department.id
      && entry.programId === selection.program.id
      && entry.batchId === selection.batch.id
      && entry.semesterId === selection.semester.id
      && entry.sectionId === selection.section.id && entry.versionId === version.id
      && subject.academicYearId === selection.academicYear.id
      && subject.departmentId === selection.department.id
      && subject.programId === selection.program.id
      && subject.batchId === selection.batch.id
      && subject.semesterId === selection.semester.id
      && faculty.departmentId === selection.department.id
      && room.campusId === selection.department.campusId
      && timeSlot.day === entry.day && timeSlot.type === 'CLASS'
      && timeSlot.start === entry.start && timeSlot.end === entry.end
    if (!validRelations) {
      addConflict('INVALID_ACADEMIC_RELATIONSHIP', `Entry ${entry.id} does not match the selected academic structure or active resources.`, entry.id)
    }

    const result = await validateTimetableEntry(database, {
      ...entry, subject, faculty, room, section: selection.section,
      cohort: `${selection.batch.name} · ${selection.section.name}`,
    }, {
      excludeEntryId: entry.id,
      additionalEntries: proposedEntries ? entries.filter((_, index) => index !== entryIndex) : [],
    })
    for (const conflict of result.conflicts) addConflict(conflict.type, conflict.message, entry.id)
  }

  for (const subject of subjects) {
    const subjectEntries = entries.filter((entry) => entry.subjectId === subject.id)
    if (!subjectEntries.length) {
      if (Number(subject.weeklyHours) > 0) {
        addConflict('MISSING_REQUIRED_ASSIGNMENT', `${subject.code} ${subject.name} has no scheduled class; ${subject.weeklyHours} weekly hours are required.`)
      }
      continue
    }
    if (!Number.isFinite(Number(subject.weeklyHours)) || Number(subject.weeklyHours) <= 0) continue
    const scheduledMinutes = subjectEntries.reduce((total, entry) => {
      const slotMinutes = Number(entry.end?.slice(0, 2)) * 60 + Number(entry.end?.slice(3, 5))
        - Number(entry.start?.slice(0, 2)) * 60 - Number(entry.start?.slice(3, 5))
      return total + (Number.isFinite(slotMinutes) ? Math.max(0, slotMinutes) : 0)
    }, 0)
    const requiredMinutes = Number(subject.weeklyHours) * 60
    if (scheduledMinutes < requiredMinutes) {
      addConflict('WEEKLY_SUBJECT_HOURS', `${subject.code} ${subject.name} has ${scheduledMinutes / 60} scheduled hours; ${subject.weeklyHours} weekly hours are required.`)
    }
    for (const [classType, configuredHours] of [['LECTURE', subject.theoryHours], ['LAB', subject.practicalHours]]) {
      if (!Number.isFinite(Number(configuredHours)) || Number(configuredHours) <= 0) continue
      const scheduledTypeMinutes = subjectEntries.filter((entry) => (
        classType === 'LAB' ? entry.classType === 'LAB' : entry.classType !== 'LAB'
      )).reduce((total, entry) => {
        const start = Number(entry.start?.slice(0, 2)) * 60 + Number(entry.start?.slice(3, 5))
        const end = Number(entry.end?.slice(0, 2)) * 60 + Number(entry.end?.slice(3, 5))
        return total + (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0)
      }, 0)
      if (scheduledTypeMinutes < Number(configuredHours) * 60) {
        addConflict('WEEKLY_SUBJECT_HOURS', `${subject.code} ${subject.name} has ${scheduledTypeMinutes / 60} ${classType === 'LAB' ? 'practical' : 'theory'} hours scheduled; ${configuredHours} are required.`)
      }
    }
  }

  return { valid: conflicts.length === 0, conflicts }
}

export async function setScheduleStatus(database, user, ids, status, transitionDetails = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'Select at least one schedule.')
  const transitions = {
    'department-admin': {
      'Awaiting approval': ['Draft', 'Returned for changes'],
      Published: ['Approved'],
    },
    'academic-admin': {
      'Under review': ['Awaiting approval'],
      Approved: ['Under review'],
      Rejected: ['Under review'],
      'Returned for changes': ['Under review'],
    },
  }
  const allowedFrom = transitions[user.role]?.[status]
  if (!allowedFrom) throw new HttpError(403, 'Your role cannot perform this schedule transition.')
  const requestedIds = [...new Set(ids.map(Number))]
  const requestedSchedules = await database.collection('schedules').find({ id: { $in: requestedIds } }).toArray()
  if (requestedSchedules.length !== requestedIds.length) throw new HttpError(409, 'One or more timetable entries no longer exist.')
  const versionIds = [...new Set(requestedSchedules.map((item) => item.versionId).filter((id) => id != null))]
  const versionSchedules = versionIds.length
    ? await database.collection('schedules').find({ versionId: { $in: versionIds } }).toArray()
    : []
  const transitionIds = [...new Set([...requestedIds, ...versionSchedules.map((item) => item.id)])]
  const filter = { id: { $in: transitionIds }, status: { $in: allowedFrom } }
  if (user.role === 'department-admin') filter.departmentId = user.departmentId
  const selectedSchedules = await database.collection('schedules').find(filter).toArray()
  if (selectedSchedules.length !== transitionIds.length) {
    throw new HttpError(409, 'Every entry in a timetable version must be at the same lifecycle stage before it can transition.')
  }
  if (status !== 'Draft') {
    const validationConflicts = []
    const processedSections = new Set()
    for (const schedule of selectedSchedules) {
      if (schedule.entrySource === 'manual') {
        const sectionKey = [schedule.versionId, schedule.academicYearId, schedule.departmentId, schedule.programId, schedule.batchId, schedule.semesterId, schedule.sectionId].join(':')
        if (processedSections.has(sectionKey)) continue
        processedSections.add(sectionKey)
        const result = await validateManualTimetable(database, user, schedule)
        validationConflicts.push(...result.conflicts)
        continue
      }
      const missing = ['subject', 'code', 'facultyId', 'roomId', 'day', 'start', 'end']
        .filter((field) => schedule[field] === undefined || schedule[field] === null || schedule[field] === '')
      if (missing.length) {
        validationConflicts.push({
          type: 'MISSING_REQUIRED_ASSIGNMENT', message: `Entry ${schedule.id} is missing ${missing.join(', ')}.`, entryId: schedule.id,
        })
        continue
      }
      const result = await validateTimetableEntry(database, schedule, { excludeEntryId: schedule.id })
      validationConflicts.push(...result.conflicts.map((conflict) => ({ ...conflict, entryId: schedule.id })))
    }
    if (validationConflicts.length) {
      throw new HttpError(409, 'Timetable validation failed. Resolve all hard conflicts before submission.', {
        valid: false, conflicts: validationConflicts,
      })
    }
  }
  const now = new Date()
  const setFields = { status }
  const update = { $set: setFields }
  if (status === 'Awaiting approval') {
    setFields.submittedBy = user.id
    setFields.submittedAt = now
  } else if (status === 'Under review') {
    setFields.reviewedBy = user.id
    setFields.reviewedAt = now
    setFields.reviewComments = typeof transitionDetails.reviewComments === 'string' ? transitionDetails.reviewComments.trim() : ''
  } else if (status === 'Approved') {
    setFields.approvedBy = user.id
    setFields.approvedAt = now
  } else if (status === 'Rejected') {
    const rejectionReason = typeof transitionDetails.rejectionReason === 'string' ? transitionDetails.rejectionReason.trim() : ''
    if (!rejectionReason) throw new HttpError(400, 'Provide a rejection reason.')
    setFields.reviewedBy = user.id
    setFields.reviewedAt = now
    setFields.reviewComments = typeof transitionDetails.reviewComments === 'string' ? transitionDetails.reviewComments.trim() : ''
    setFields.rejectionReason = rejectionReason
  } else if (status === 'Returned for changes') {
    const reviewComments = typeof transitionDetails.reviewComments === 'string' ? transitionDetails.reviewComments.trim() : ''
    if (!reviewComments) throw new HttpError(400, 'Provide review comments describing the required changes.')
    setFields.reviewedBy = user.id
    setFields.reviewedAt = now
    setFields.reviewComments = reviewComments
  }
  const schedulesToPublish = status === 'Published'
    ? selectedSchedules
    : []
  const result = await database.collection('schedules').updateMany(filter, update)
  if (result.modifiedCount !== transitionIds.length) throw new HttpError(409, 'One or more schedules changed or are outside your department.')
  const versionMetadata = Object.fromEntries(Object.entries(setFields).filter(([field]) => (
    ['status', 'submittedBy', 'submittedAt', 'reviewedBy', 'reviewedAt', 'approvedBy', 'approvedAt', 'rejectionReason', 'reviewComments'].includes(field)
  )))
  for (const versionId of versionIds) {
    const version = await database.collection('timetable_versions').findOne({ id: versionId })
    if (!version) continue
    if (status === 'Published') {
      const previousVersions = await database.collection('timetable_versions').find({
        academicYearId: version.academicYearId, departmentId: version.departmentId,
        programId: version.programId, batchId: version.batchId, semesterId: version.semesterId,
        sectionId: version.sectionId, status: 'Published', id: { $ne: versionId },
      }).toArray()
      for (const previous of previousVersions) {
        await database.collection('timetable_versions').updateOne({ id: previous.id }, { $set: { status: 'Archived' } })
        await database.collection('schedules').updateMany({ versionId: previous.id, status: 'Published' }, { $set: { status: 'Archived' } })
      }
      versionMetadata.publishedAt = now
    }
    await database.collection('timetable_versions').updateOne({ id: versionId }, { $set: versionMetadata })
  }
  if (schedulesToPublish.length) await notifyStudentsOfPublishedSchedules(database, schedulesToPublish)
  const actionLabels = {
    'Awaiting approval': 'Submitted timetable', 'Under review': 'Started timetable review',
    Approved: 'Approved timetable', Rejected: 'Rejected timetable',
    'Returned for changes': 'Returned timetable for changes', Published: 'Published timetable',
  }
  const details = status === 'Rejected' ? setFields.rejectionReason
    : status === 'Returned for changes' || status === 'Under review' ? setFields.reviewComments || status
      : status
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: actionLabels[status] || 'Updated timetable status', target: `${result.modifiedCount} schedule(s)`, details })
  return { updated: result.modifiedCount, status, versionIds }
}

export async function setFacultyAvailability(database, user, facultyId, available) {
  const faculty = await database.collection('users').findOne({ id: Number(facultyId), role: 'faculty' })
  if (!faculty) throw new HttpError(404, 'Faculty member not found.')
  if (user.role === 'department-admin' && faculty.departmentId !== user.departmentId) throw new HttpError(403, 'You can only manage faculty in your department.')
  if (typeof available !== 'boolean') throw new HttpError(400, 'Availability must be true or false.')
  await database.collection('users').updateOne(byId(faculty.id), { $set: { available } })
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Updated faculty availability', target: faculty.name, details: available ? 'Available' : 'Unavailable' })
  return { id: faculty.id, available }
}

export async function getCalendarData(database) {
  const [workingDays, timeSlots] = await Promise.all([
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
    database.collection('time_slots').find().toArray(),
  ])
  return { workingDays: workingDays.map((item) => item.day), timeSlots: sortCalendarSlots(timeSlots) }
}

function sortCalendarSlots(slots) {
  return slots.sort((left, right) => dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day)
    || left.sequence - right.sequence)
    .map(({ id, day, start, end, type, sequence, status }) => ({ id, day, start, end, type, sequence, status }))
}

function validateCalendarSlots(inputSlots) {
  const slots = inputSlots.map((slot) => {
    if (!dayOrder.includes(slot?.day)) throw new HttpError(400, 'Choose a valid day for every time slot.')
    if (typeof slot.start !== 'string' || typeof slot.end !== 'string'
      || !timePattern.test(slot.start) || !timePattern.test(slot.end) || slot.start >= slot.end) {
      throw new HttpError(400, 'Time slots must use valid times with start before end.')
    }
    if (!slotTypes.has(slot.type)) throw new HttpError(400, 'Choose CLASS, BREAK, or LUNCH for every time slot.')
    if (!Number.isSafeInteger(slot.sequence) || slot.sequence < 1) throw new HttpError(400, 'Time slot sequence must be a positive whole number.')
    if (!slotStatuses.has(slot.status)) throw new HttpError(400, 'Time slot status must be Active or Inactive.')
    return { id: slot.id, day: slot.day, start: slot.start, end: slot.end, type: slot.type, sequence: slot.sequence, status: slot.status }
  })
  const slotsByDay = new Map(dayOrder.map((day) => [day, []]))
  for (const slot of slots) slotsByDay.get(slot.day).push(slot)
  for (const [day, daySlots] of slotsByDay) {
    daySlots.sort((left, right) => left.sequence - right.sequence)
    if (daySlots.some((slot, index) => slot.sequence !== index + 1)) {
      throw new HttpError(400, `${day} time slot sequence must start at 1 and be consecutive.`)
    }
    const chronological = [...daySlots].sort((left, right) => left.start.localeCompare(right.start))
    if (daySlots.some((slot, index) => slot !== chronological[index])) {
      throw new HttpError(400, `${day} time slot sequence must follow chronological order.`)
    }
    for (let index = 1; index < chronological.length; index += 1) {
      if (chronological[index].start < chronological[index - 1].end) {
        throw new HttpError(400, `${day} time slots must not overlap.`)
      }
    }
  }
  return slots.sort((left, right) => dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day)
    || left.sequence - right.sequence)
}

export async function saveAcademicCalendar(database, user, input) {
  if (user.role !== 'academic-admin') throw new HttpError(403, 'Only Academic Admins can change institution working hours.')
  if (!Array.isArray(input.workingDays) || !Array.isArray(input.timeSlots)) throw new HttpError(400, 'Provide working days and time slots.')
  const validDays = new Set(dayOrder)
  if (input.workingDays.some((day) => !validDays.has(day)) || new Set(input.workingDays).size !== input.workingDays.length) {
    throw new HttpError(400, 'Choose valid, non-duplicated working days.')
  }
  const timeSlots = validateCalendarSlots(input.timeSlots)
  await database.collection('working_days').updateMany({}, { $set: { enabled: false } })
  if (input.workingDays.length) await database.collection('working_days').updateMany({ day: { $in: input.workingDays } }, { $set: { enabled: true } })
  // Update existing slots in place (keeping their ids) so timetable entries that
  // reference timeSlotId keep working; only add new and remove stale slots.
  const existingSlots = await database.collection('time_slots').find({}).toArray()
  const existingIds = new Set(existingSlots.map((slot) => slot.id))
  const keptIds = new Set()
  const savedSlots = []
  for (const { id: rawId, ...slot } of timeSlots) {
    const parsedId = Number(rawId)
    const keepId = Number.isSafeInteger(parsedId) && existingIds.has(parsedId) && !keptIds.has(parsedId) ? parsedId : null
    if (keepId == null) {
      const id = await insertRecord(database, 'time_slots', slot)
      savedSlots.push({ id, ...slot })
      continue
    }
    keptIds.add(keepId)
    await database.collection('time_slots').updateOne({ id: keepId }, { $set: slot })
    savedSlots.push({ id: keepId, ...slot })
  }
  const staleIds = existingSlots.map((slot) => slot.id).filter((id) => !keptIds.has(id))
  if (staleIds.length) await database.collection('time_slots').deleteMany({ id: { $in: staleIds } })
  const orderedWorkingDays = input.workingDays.sort((left, right) => dayOrder.indexOf(left) - dayOrder.indexOf(right))
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Updated institution calendar', target: 'Working days and time slots', details: `${orderedWorkingDays.length} working days, ${savedSlots.length} time slots` })
  return { workingDays: orderedWorkingDays, timeSlots: sortCalendarSlots(savedSlots) }
}

export async function getScheduleReport(database, user) {
  const filter = user.role === 'department-admin' ? { departmentId: user.departmentId } : {}
  const schedules = sortByDayAndTime(await database.collection('schedules').find(filter).toArray())
  const [departments, faculty, rooms] = await Promise.all([
    database.collection('departments').find({ id: { $in: schedules.map((item) => item.departmentId) } }).toArray(),
    database.collection('users').find({ id: { $in: schedules.map((item) => item.facultyId) } }).toArray(),
    database.collection('rooms').find({ id: { $in: schedules.map((item) => item.roomId) } }).toArray(),
  ])
  const departmentMap = new Map(departments.map((item) => [item.id, item.name]))
  const facultyMap = new Map(faculty.map((item) => [item.id, item.name]))
  const roomMap = new Map(rooms.map((item) => [item.id, item.name]))
  return schedules.map((item) => ({
    department: departmentMap.get(item.departmentId), day: item.day, start: item.start, end: item.end,
    subject: item.subject, code: item.code, faculty: facultyMap.get(item.facultyId),
    room: roomMap.get(item.roomId), status: item.status,
  }))
}
