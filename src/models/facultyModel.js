import { HttpError } from '../utils/httpError.js'
import { hashPassword } from '../utils/passwords.js'
import { writeAudit } from './auditModel.js'
import { byId, insertRecord } from './dataHelpers.js'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`)
  return value.trim()
}

function normalizeIds(values, field) {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new HttpError(400, `${field} must be a list.`)
  const ids = values.map(Number)
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new HttpError(400, `Choose valid ${field.toLowerCase()}.`)
  if (new Set(ids).size !== ids.length) throw new HttpError(400, `${field} must not contain duplicates.`)
  return ids
}

function normalizeSlots(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list of time slots.`)
  const slots = value.map((slot) => {
    const day = requireText(slot?.day, `${field} day`)
    const start = requireText(slot?.start, `${field} start time`)
    const end = requireText(slot?.end, `${field} end time`)
    if (!weekdays.includes(day) || !timePattern.test(start) || !timePattern.test(end) || start >= end) {
      throw new HttpError(400, `${field} must use a valid weekday and a start time before its end time.`)
    }
    return { day, start, end }
  }).sort((left, right) => weekdays.indexOf(left.day) - weekdays.indexOf(right.day) || left.start.localeCompare(right.start))
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index - 1].day === slots[index].day && slots[index].start < slots[index - 1].end) {
      throw new HttpError(400, `${field} slots must not overlap.`)
    }
  }
  return slots
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function validateProfile(database, input, current) {
  const facultyCode = requireText(input.facultyCode, 'Faculty ID').toUpperCase()
  if (facultyCode.length > 30) throw new HttpError(400, 'Faculty ID must be 30 characters or fewer.')
  const name = requireText(input.name, 'Name')
  const email = requireText(input.email, 'Email').toLowerCase()
  const designation = requireText(input.designation, 'Designation')
  const departmentId = Number(input.departmentId)
  if (!Number.isSafeInteger(departmentId) || departmentId < 1) throw new HttpError(400, 'Choose a valid department.')
  const department = await database.collection('departments').findOne({ id: departmentId, status: 'Active' })
  if (!department) throw new HttpError(400, 'Choose an active department.')
  const maxTeachingHours = Number(input.maxTeachingHours)
  if (!Number.isInteger(maxTeachingHours) || maxTeachingHours < 1 || maxTeachingHours > 60) {
    throw new HttpError(400, 'Maximum teaching hours must be a whole number between 1 and 60.')
  }

  const subjectIds = normalizeIds(input.subjectIds, 'Subjects')
  if (subjectIds.length) {
    const subjects = await database.collection('subjects').find({ id: { $in: subjectIds }, departmentId, status: 'Active' }).toArray()
    if (subjects.length !== subjectIds.length) throw new HttpError(400, 'Choose active subjects in the selected department.')
  }

  const sectionIds = normalizeIds(input.sectionIds, 'Sections')
  if (sectionIds.length) {
    const sections = await database.collection('sections').find({ id: { $in: sectionIds }, status: 'Active' }).toArray()
    if (sections.length !== sectionIds.length) throw new HttpError(400, 'Choose active sections.')
    const semesters = await database.collection('semesters').find({ id: { $in: sections.map((section) => section.semesterId) } }).toArray()
    const batches = await database.collection('batches').find({ id: { $in: semesters.map((semester) => semester.batchId) } }).toArray()
    const programs = await database.collection('programs').find({ id: { $in: batches.map((batch) => batch.programId) } }).toArray()
    const programDepartments = new Map(programs.map((program) => [program.id, program.departmentId]))
    const batchById = new Map(batches.map((batch) => [batch.id, batch]))
    const semesterById = new Map(semesters.map((semester) => [semester.id, semester]))
    if (sections.some((section) => {
      const semester = semesterById.get(section.semesterId)
      const batch = semester && batchById.get(semester.batchId)
      return !batch || batch.departmentId !== departmentId || programDepartments.get(batch.programId) !== departmentId
    })) throw new HttpError(400, 'Choose sections in the selected department.')
  }

  const availableSlots = normalizeSlots(input.availableSlots, 'Available time')
  const unavailableSlots = normalizeSlots(input.unavailableSlots, 'Unavailable time')
  const preferredSlots = normalizeSlots(input.preferredSlots, 'Preferred time')
  if (preferredSlots.some((preferred) => !availableSlots.some((available) => (
    available.day === preferred.day && available.start <= preferred.start && available.end >= preferred.end
  )))) throw new HttpError(400, 'Preferred slots must fall within available time slots.')

  const password = input.password ? requireText(input.password, 'Password') : ''
  if (!current && password.length < 8) throw new HttpError(400, 'Initial password must contain at least 8 characters.')
  if (password && password.length < 8) throw new HttpError(400, 'Password must contain at least 8 characters.')
  if (input.available !== undefined && typeof input.available !== 'boolean') {
    throw new HttpError(400, 'Availability must be true or false.')
  }
  const availabilityDays = [...new Set(availableSlots.map((slot) => slot.day))].join(',')
  return {
    facultyCode, name, email, designation, departmentId, campusId: department.campusId,
    subjectIds, sectionIds, maxTeachingHours, availableSlots, unavailableSlots, preferredSlots,
    availabilityDays, ...(input.available === undefined ? {} : { available: input.available }),
    ...(password ? { passwordHash: hashPassword(password) } : {}),
  }
}

async function formatFaculty(database, faculty) {
  if (!faculty) return null
  const [department, assignedSubjects, assignedSections] = await Promise.all([
    database.collection('departments').findOne({ id: faculty.departmentId }),
    database.collection('subjects').find({ facultyId: faculty.id }).toArray(),
    faculty.sectionIds?.length
      ? database.collection('sections').find({ id: { $in: faculty.sectionIds } }).toArray()
      : Promise.resolve([]),
  ])
  const subjectIds = [...new Set([...(faculty.subjectIds || []), ...assignedSubjects.map((subject) => subject.id)])]
  const subjects = subjectIds.length
    ? await database.collection('subjects').find({ id: { $in: subjectIds } }).toArray()
    : []
  return {
    id: faculty.id, facultyCode: faculty.facultyCode || `FAC-${faculty.id}`, name: faculty.name, email: faculty.email,
    departmentId: faculty.departmentId, department: department?.name || '', designation: faculty.designation || '',
    subjectIds, subjects: subjects.map((subject) => `${subject.code} · ${subject.name}`),
    sectionIds: assignedSections.map((section) => section.id),
    sections: assignedSections.map((section) => `${section.code} · ${section.name}`),
    maxTeachingHours: faculty.maxTeachingHours ?? 20,
    availableSlots: faculty.availableSlots || [], unavailableSlots: faculty.unavailableSlots || [],
    preferredSlots: faculty.preferredSlots || [], available: faculty.available !== false, status: faculty.status,
  }
}

export async function getFacultyOptions(database) {
  const [departments, subjects, sections, semesters, batches, programs, workingDays, timeSlots] = await Promise.all([
    database.collection('departments').find({ status: 'Active' }).sort({ name: 1 }).toArray(),
    database.collection('subjects').find({ status: 'Active' }).sort({ name: 1 }).toArray(),
    database.collection('sections').find({ status: 'Active' }).sort({ name: 1 }).toArray(),
    database.collection('semesters').find().toArray(),
    database.collection('batches').find().toArray(),
    database.collection('programs').find().toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
    database.collection('time_slots').find().sort({ start: 1 }).toArray(),
  ])
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))
  const semesterById = new Map(semesters.map((semester) => [semester.id, semester]))
  const programById = new Map(programs.map((program) => [program.id, program]))
  return {
    departments: departments.map(({ id, name }) => ({ id, name })),
    subjects: subjects.map(({ id, departmentId, code, name }) => ({ id, departmentId, label: `${code} · ${name}` })),
    sections: sections.map((section) => {
      const semester = semesterById.get(section.semesterId)
      const batch = semester && batchById.get(semester.batchId)
      return {
        id: section.id, departmentId: batch?.departmentId,
        label: `${section.code} · ${section.name}${batch ? ` · ${programById.get(batch.programId)?.name || batch.name}` : ''}`,
      }
    }).filter((section) => section.departmentId),
    days: workingDays.map(({ day }) => day),
    timeSlots: timeSlots.map(({ start, end }) => ({ start, end })),
  }
}

export async function listFaculty(database, filters = {}) {
  const query = { role: 'faculty' }
  if (filters.departmentId) {
    const departmentId = Number(filters.departmentId)
    if (!Number.isSafeInteger(departmentId) || departmentId < 1) throw new HttpError(400, 'Choose a valid department filter.')
    query.departmentId = departmentId
  }
  if (filters.status && ['Active', 'Inactive'].includes(filters.status)) query.status = filters.status
  const search = typeof filters.search === 'string' ? filters.search.trim() : ''
  if (search) {
    const matcher = new RegExp(escapedRegex(search), 'i')
    const matchingDepartments = await database.collection('departments').find({ name: matcher }, { projection: { id: 1 } }).toArray()
    query.$or = [
      { facultyCode: matcher }, { name: matcher }, { email: matcher }, { designation: matcher },
      ...(matchingDepartments.length ? [{ departmentId: { $in: matchingDepartments.map((department) => department.id) } }] : []),
    ]
  }
  const faculty = await database.collection('users').find(query).sort({ name: 1 }).toArray()
  return Promise.all(faculty.map((item) => formatFaculty(database, item)))
}

export async function getFaculty(database, id) {
  const faculty = await database.collection('users').findOne({ ...byId(id), role: 'faculty' })
  if (!faculty) throw new HttpError(404, 'Faculty member not found.')
  return formatFaculty(database, faculty)
}

export async function createFaculty(database, actor, input) {
  const fields = await validateProfile(database, input)
  if (fields.subjectIds.length) {
    const assignedSubjects = await database.collection('subjects').find({ id: { $in: fields.subjectIds } }).toArray()
    if (assignedSubjects.some((subject) => subject.facultyId != null)) {
      throw new HttpError(409, 'One or more selected subjects are already assigned to another faculty member.')
    }
  }
  const id = await insertRecord(database, 'users', {
    ...fields, passwordHash: fields.passwordHash, role: 'faculty', programId: null, cohort: '',
    available: fields.available ?? true, status: 'Active',
  })
  if (fields.subjectIds.length) await database.collection('subjects').updateMany({ id: { $in: fields.subjectIds } }, { $set: { facultyId: id } })
  const record = await getFaculty(database, id)
  await writeAudit(database, { actorId: actor.id, actorName: actor.name, action: 'Created faculty member', target: record.name, details: `${record.facultyCode} · ${record.department}` })
  return record
}

export async function updateFaculty(database, actor, id, input) {
  const facultyId = Number(id)
  const current = await database.collection('users').findOne({ ...byId(facultyId), role: 'faculty' })
  if (!current) throw new HttpError(404, 'Faculty member not found.')
  const fields = await validateProfile(database, input, current)
  const currentlyAssigned = await database.collection('subjects').find({ facultyId }).toArray()
  const subjectIds = [...new Set([...(fields.subjectIds || []), ...currentlyAssigned.map((subject) => subject.id)])]
  const selectedSubjectIds = fields.subjectIds
  const unavailableSubjects = selectedSubjectIds.length
    ? (await database.collection('subjects').find({ id: { $in: selectedSubjectIds } }).toArray())
      .filter((subject) => subject.facultyId != null && subject.facultyId !== facultyId)
    : []
  if (unavailableSubjects.length) throw new HttpError(409, 'One or more selected subjects are already assigned to another faculty member.')
  const removeSubjectIds = subjectIds.filter((subjectId) => !selectedSubjectIds.includes(subjectId))
  if (removeSubjectIds.length) await database.collection('subjects').updateMany({ id: { $in: removeSubjectIds }, facultyId }, { $set: { facultyId: null } })
  if (selectedSubjectIds.length) await database.collection('subjects').updateMany({ id: { $in: selectedSubjectIds } }, { $set: { facultyId } })
  const { passwordHash, ...profileFields } = fields
  if (passwordHash) profileFields.passwordHash = passwordHash
  await database.collection('users').updateOne(byId(facultyId), { $set: profileFields })
  const record = await getFaculty(database, facultyId)
  await writeAudit(database, { actorId: actor.id, actorName: actor.name, action: 'Updated faculty member', target: record.name, details: `${record.facultyCode} · ${record.department}` })
  return record
}

export async function deleteFaculty(database, actor, id) {
  const record = await getFaculty(database, id)
  const hasSchedules = await database.collection('schedules').countDocuments({ facultyId: record.id })
  if (hasSchedules) throw new HttpError(409, 'This faculty member is referenced by timetable entries and cannot be deleted.')
  await database.collection('subjects').updateMany({ facultyId: record.id }, { $set: { facultyId: null } })
  await database.collection('users').deleteOne({ ...byId(record.id), role: 'faculty' })
  await writeAudit(database, { actorId: actor.id, actorName: actor.name, action: 'Deleted faculty member', target: record.name, details: `${record.facultyCode} removed from faculty management` })
  return { id: record.id, deleted: true }
}