import { HttpError } from '../utils/httpError.js'
import { hashPassword } from '../utils/passwords.js'
import { listAudit, writeAudit } from './auditModel.js'
import { byId, insertRecord, sortByName } from './dataHelpers.js'

const roleValues = { Student: 'student', Faculty: 'faculty', 'Department Admin': 'department-admin', 'Academic Admin': 'academic-admin', 'Super Admin': 'super-admin' }
const roleLabels = Object.fromEntries(Object.entries(roleValues).map(([label, value]) => [value, label]))
const entities = {
  'academic-years': { collection: 'academic_years', singular: 'academic year', structure: true },
  users: { collection: 'users', singular: 'user' }, departments: { collection: 'departments', singular: 'department', structure: true },
  programs: { collection: 'programs', singular: 'program', structure: true }, batches: { collection: 'batches', singular: 'batch', structure: true },
  semesters: { collection: 'semesters', singular: 'semester', structure: true }, sections: { collection: 'sections', singular: 'section', structure: true },
  subjects: { collection: 'subjects', singular: 'subject', structure: true },
  campuses: { collection: 'campuses', singular: 'campus' }, rooms: { collection: 'rooms', singular: 'room' },
}

const subjectTypes = new Set(['Core', 'Elective', 'General'])

function getEntityConfig(entity) {
  const config = entities[entity]
  if (!config) throw new HttpError(404, 'Unknown system directory.')
  return config
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`)
  return value.trim()
}

function requireId(value, field) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, `Choose a valid ${field.toLowerCase()}.`)
  return id
}

function validateDateRange(startDate, endDate, label) {
  const start = startDate || ''
  const end = endDate || ''
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  if (Boolean(start) !== Boolean(end)) throw new HttpError(400, `${label} start and end dates must both be provided.`)
  if (!start) return { startDate: '', endDate: '' }
  if (!isDate(start) || !isDate(end) || start >= end) throw new HttpError(400, `${label} dates must be valid and the end date must follow the start date.`)
  return { startDate: start, endDate: end }
}

async function findActiveRecord(database, collectionName, value, label) {
  const id = requireId(value, label)
  const record = await database.collection(collectionName).findOne({ id, status: 'Active' })
  if (!record) throw new HttpError(400, `Choose an active ${label.toLowerCase()}.`)
  return record
}

async function validateAcademicYearIds(database, values) {
  if (!Array.isArray(values) || values.length === 0) throw new HttpError(400, 'Choose at least one academic year.')
  const ids = values.map((value) => requireId(value, 'Academic year'))
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length !== ids.length) throw new HttpError(400, 'Academic years must not be duplicated.')
  const count = await database.collection('academic_years').countDocuments({ id: { $in: uniqueIds }, status: 'Active' })
  if (count !== uniqueIds.length) throw new HttpError(400, 'Choose active academic years.')
  return uniqueIds
}

async function findCampusId(database, campusName) {
  const campus = await database.collection('campuses').findOne({ name: requireText(campusName, 'Campus') })
  if (!campus) throw new HttpError(400, 'Choose an existing campus.')
  return campus.id
}

async function findDepartmentId(database, departmentName, nullable = false) {
  if (nullable && departmentName === 'Institution') return null
  const department = await database.collection('departments').findOne({ name: requireText(departmentName, 'Department') })
  if (!department) throw new HttpError(400, 'Choose an existing department.')
  return department.id
}

async function findProgramId(database, programName, departmentId, nullable = false) {
  if (nullable && !programName) return null
  const program = await database.collection('programs').findOne({ name: requireText(programName, 'Program') })
  if (!program) throw new HttpError(400, 'Choose an existing program.')
  if (program.departmentId !== departmentId) throw new HttpError(400, 'Choose a program in the selected department.')
  return program.id
}

function validateRoomCapacity(value) {
  const capacity = Number(value)
  if (!Number.isInteger(capacity) || capacity < 0) throw new HttpError(400, 'Room capacity must be a whole number of zero or more.')
  return capacity
}

function validateWholeNumber(value, field, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}.`)
  }
  return number
}

async function validateSubjectInput(database, input) {
  const academicYear = await findActiveRecord(database, 'academic_years', input.academicYearId, 'Academic year')
  const department = await findActiveRecord(database, 'departments', input.departmentId, 'Department')
  const program = await findActiveRecord(database, 'programs', input.programId, 'Program')
  const batch = await findActiveRecord(database, 'batches', input.batchId, 'Batch')
  const semester = await findActiveRecord(database, 'semesters', input.semesterId, 'Semester')
  if (!(department.academicYearIds || []).includes(academicYear.id)) throw new HttpError(400, 'The department is not offered in the selected academic year.')
  if (program.departmentId !== department.id) throw new HttpError(400, 'Choose a program in the selected department.')
  if (batch.academicYearId !== academicYear.id || batch.departmentId !== department.id || batch.programId !== program.id) {
    throw new HttpError(400, 'Choose a batch that belongs to the selected academic year, department, and program.')
  }
  if (semester.batchId !== batch.id) throw new HttpError(400, 'Choose a semester that belongs to the selected batch.')

  const code = requireText(input.code, 'Subject code').toUpperCase()
  if (code.length > 30) throw new HttpError(400, 'Subject code must be 30 characters or fewer.')
  const type = requireText(input.type, 'Subject type')
  if (!subjectTypes.has(type)) throw new HttpError(400, 'Choose a valid subject type.')
  const credits = validateWholeNumber(input.credits, 'Credits', 1, 30)
  const weeklyHours = validateWholeNumber(input.weeklyHours, 'Weekly hours', 1, 40)
  const theoryHours = validateWholeNumber(input.theoryHours, 'Theory hours', 0, 40)
  const practicalHours = validateWholeNumber(input.practicalHours, 'Practical hours', 0, 40)
  if (theoryHours + practicalHours !== weeklyHours) throw new HttpError(400, 'Theory and practical hours must add up to weekly hours.')
  if (typeof input.requiresLab !== 'boolean') throw new HttpError(400, 'Specify whether this subject requires a lab.')
  if (input.requiresLab && practicalHours === 0) throw new HttpError(400, 'A lab-required subject must have at least one practical hour.')

  let facultyId = null
  if (input.facultyId !== '' && input.facultyId !== null && input.facultyId !== undefined) {
    const faculty = await findActiveRecord(database, 'users', input.facultyId, 'Faculty member')
    if (faculty.role !== 'faculty' || faculty.departmentId !== department.id) {
      throw new HttpError(400, 'Choose an active faculty member in the selected department.')
    }
    facultyId = faculty.id
  }

  return {
    code, name: requireText(input.name, 'Subject name'), credits, type,
    academicYearId: academicYear.id, departmentId: department.id, programId: program.id,
    batchId: batch.id, semesterId: semester.id, weeklyHours, theoryHours, practicalHours,
    facultyId, requiresLab: input.requiresLab,
  }
}

async function formatRecords(database, entity, records) {
  const lookups = {
    users: { departmentId: 'departments', programId: 'programs', campusId: 'campuses' },
    departments: { campusId: 'campuses', academicYearIds: 'academic_years' },
    programs: { departmentId: 'departments' },
    batches: { academicYearId: 'academic_years', departmentId: 'departments', programId: 'programs' },
    semesters: { batchId: 'batches' },
    sections: { semesterId: 'semesters' },
    subjects: {
      academicYearId: 'academic_years', departmentId: 'departments', programId: 'programs',
      batchId: 'batches', semesterId: 'semesters', facultyId: 'users',
    },
    rooms: { campusId: 'campuses' },
  }[entity]
  const namesByField = {}
  for (const [field, collectionName] of Object.entries(lookups || {})) {
    const ids = [...new Set(records.flatMap((record) => {
      const value = record[field]
      return Array.isArray(value) ? value : value == null ? [] : [value]
    }))]
    const related = ids.length ? await database.collection(collectionName).find({ id: { $in: ids } }).toArray() : []
    namesByField[field] = new Map(related.map((record) => [record.id, record]))
  }
  records = records.map((record) => {
    const formatted = { ...record }
    if (entity === 'users') {
      formatted.department = namesByField.departmentId.get(record.departmentId)?.name ?? null
      formatted.program = namesByField.programId.get(record.programId)?.name ?? null
      formatted.campus = namesByField.campusId.get(record.campusId)?.name ?? null
      formatted.role = roleLabels[record.role]
    } else if (entity === 'departments') {
      formatted.campus = namesByField.campusId.get(record.campusId)?.name ?? null
      formatted.academicYearIds = record.academicYearIds || []
      formatted.academicYears = formatted.academicYearIds.map((id) => namesByField.academicYearIds.get(id)?.name).filter(Boolean)
    } else if (entity === 'programs') formatted.department = namesByField.departmentId.get(record.departmentId)?.name ?? null
    else if (entity === 'batches') {
      formatted.academicYear = namesByField.academicYearId.get(record.academicYearId)?.name ?? null
      formatted.department = namesByField.departmentId.get(record.departmentId)?.name ?? null
      formatted.program = namesByField.programId.get(record.programId)?.name ?? null
    } else if (entity === 'semesters') formatted.batch = namesByField.batchId.get(record.batchId)?.name ?? null
    else if (entity === 'sections') formatted.semester = namesByField.semesterId.get(record.semesterId)?.name ?? null
    else if (entity === 'subjects') {
      formatted.academicYear = namesByField.academicYearId.get(record.academicYearId)?.name ?? null
      formatted.department = namesByField.departmentId.get(record.departmentId)?.name ?? null
      formatted.program = namesByField.programId.get(record.programId)?.name ?? null
      formatted.batch = namesByField.batchId.get(record.batchId)?.name ?? null
      formatted.semester = namesByField.semesterId.get(record.semesterId)?.name ?? null
      formatted.faculty = namesByField.facultyId.get(record.facultyId)?.name ?? null
    } else if (entity === 'rooms') formatted.campus = namesByField.campusId.get(record.campusId)?.name ?? null
    return formatted
  })
  const fields = {
    'academic-years': ['id', 'name', 'startDate', 'endDate', 'status'],
    users: ['id', 'name', 'email', 'role', 'department', 'program', 'cohort', 'campus', 'status'],
    departments: ['id', 'name', 'code', 'academicYearIds', 'academicYears', 'campus', 'head', 'status'],
    programs: ['id', 'name', 'code', 'departmentId', 'department', 'level', 'status'],
    batches: ['id', 'name', 'code', 'academicYearId', 'academicYear', 'departmentId', 'department', 'programId', 'program', 'status'],
    semesters: ['id', 'name', 'batchId', 'batch', 'startDate', 'endDate', 'status'],
    sections: ['id', 'name', 'code', 'semesterId', 'semester', 'status'],
    subjects: [
      'id', 'code', 'name', 'credits', 'type', 'academicYearId', 'academicYear', 'departmentId', 'department',
      'programId', 'program', 'batchId', 'batch', 'semesterId', 'semester', 'weeklyHours', 'theoryHours',
      'practicalHours', 'facultyId', 'faculty', 'requiresLab', 'status',
    ],
    campuses: ['id', 'name', 'code', 'location', 'status'],
    rooms: ['id', 'name', 'code', 'campus', 'capacity', 'type', 'status'],
  }[entity]
  return sortByName(records).map((record) => Object.fromEntries(fields.map((field) => [field, record[field]])))
}

export async function listSystemEntities(database, entity) {
  const config = getEntityConfig(entity)
  const records = await database.collection(config.collection).find().toArray()
  return formatRecords(database, entity, records)
}

export async function getSystemEntity(database, entity, id) {
  const config = getEntityConfig(entity)
  const records = await database.collection(config.collection).find(byId(id)).toArray()
  const [record] = await formatRecords(database, entity, records)
  if (!record) throw new HttpError(404, 'Record not found.')
  return record
}

async function insertEntity(database, entity, input) {
  switch (entity) {
    case 'subjects':
      return insertRecord(database, 'subjects', { ...await validateSubjectInput(database, input), status: 'Active' })
    case 'academic-years': {
      const { startDate, endDate } = validateDateRange(input.startDate, input.endDate, 'Academic year')
      return insertRecord(database, 'academic_years', {
        name: requireText(input.name, 'Academic year'), startDate, endDate, status: 'Active',
      })
    }
    case 'users': {
      const name = requireText(input.name, 'Name')
      const email = requireText(input.email, 'Email').toLowerCase()
      const role = roleValues[input.role]
      if (!role) throw new HttpError(400, 'Choose a valid user role.')
      const departmentId = await findDepartmentId(database, input.department, true)
      const programId = await findProgramId(database, input.program, departmentId, true)
      const campusId = await findCampusId(database, input.campus)
      const cohort = input.cohort?.trim() || ''
      const password = requireText(input.password, 'Initial password')
      if (password.length < 8) throw new HttpError(400, 'Initial password must contain at least 8 characters.')
      return insertRecord(database, 'users', {
        name, email, passwordHash: hashPassword(password), role, departmentId, programId,
        cohort, campusId, availabilityDays: 'Monday,Wednesday,Friday', available: true, status: 'Active',
      })
    }
    case 'departments': {
      const academicYearIds = await validateAcademicYearIds(database, input.academicYearIds)
      return insertRecord(database, 'departments', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        academicYearIds, campusId: await findCampusId(database, input.campus), head: input.head?.trim() || '', status: 'Active',
      })
    }
    case 'programs': {
      const department = await findActiveRecord(database, 'departments', input.departmentId, 'Department')
      return insertRecord(database, 'programs', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        departmentId: department.id, level: requireText(input.level, 'Award level'), status: 'Active',
      })
    }
    case 'batches': {
      const academicYear = await findActiveRecord(database, 'academic_years', input.academicYearId, 'Academic year')
      const department = await findActiveRecord(database, 'departments', input.departmentId, 'Department')
      const program = await findActiveRecord(database, 'programs', input.programId, 'Program')
      if (program.departmentId !== department.id) throw new HttpError(400, 'Choose a program in the selected department.')
      if (!(department.academicYearIds || []).includes(academicYear.id)) throw new HttpError(400, 'The selected department is not offered in this academic year.')
      return insertRecord(database, 'batches', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        academicYearId: academicYear.id, departmentId: department.id, programId: program.id, status: 'Active',
      })
    }
    case 'semesters': {
      const batch = await findActiveRecord(database, 'batches', input.batchId, 'Batch')
      const { startDate, endDate } = validateDateRange(input.startDate, input.endDate, 'Semester')
      const academicYear = await database.collection('academic_years').findOne({ id: batch.academicYearId })
      if (startDate && academicYear?.startDate && (startDate < academicYear.startDate || endDate > academicYear.endDate)) {
        throw new HttpError(400, 'Semester dates must fall within the academic year.')
      }
      return insertRecord(database, 'semesters', {
        name: requireText(input.name, 'Semester name'), batchId: batch.id, startDate, endDate, status: 'Active',
      })
    }
    case 'sections': {
      const semester = await findActiveRecord(database, 'semesters', input.semesterId, 'Semester')
      return insertRecord(database, 'sections', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        semesterId: semester.id, status: 'Active',
      })
    }
    case 'campuses':
      return insertRecord(database, 'campuses', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        location: input.location?.trim() || '', status: 'Active',
      })
    case 'rooms':
      return insertRecord(database, 'rooms', {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        campusId: await findCampusId(database, input.campus), capacity: validateRoomCapacity(input.capacity),
        type: requireText(input.type, 'Room type'), status: 'Active',
      })
    default: throw new HttpError(404, 'Unknown system directory.')
  }
}

async function updateEntity(database, entity, id, input) {
  const config = getEntityConfig(entity)
  const current = await database.collection(config.collection).findOne(byId(id))
  if (!current) throw new HttpError(404, 'Record not found.')
  let fields
  switch (entity) {
    case 'subjects':
      fields = await validateSubjectInput(database, input)
      break
    case 'academic-years': {
      const { startDate, endDate } = validateDateRange(input.startDate, input.endDate, 'Academic year')
      if (startDate) {
        const batches = await database.collection('batches').find({ academicYearId: current.id }, { projection: { id: 1 } }).toArray()
        const semesters = batches.length
          ? await database.collection('semesters').find({
            batchId: { $in: batches.map((batch) => batch.id) }, startDate: { $ne: '' }, endDate: { $ne: '' },
          }).toArray()
          : []
        if (semesters.some((semester) => semester.startDate < startDate || semester.endDate > endDate)) {
          throw new HttpError(409, 'Update descendant semester dates before changing this academic year range.')
        }
      }
      fields = { name: requireText(input.name, 'Academic year'), startDate, endDate }
      break
    }
    case 'users': {
      const role = roleValues[input.role]
      if (!role) throw new HttpError(400, 'Choose a valid user role.')
      const departmentId = await findDepartmentId(database, input.department, true)
      fields = {
        name: requireText(input.name, 'Name'), email: requireText(input.email, 'Email').toLowerCase(), role,
        departmentId, programId: await findProgramId(database, input.program, departmentId, true),
        cohort: input.cohort?.trim() || '', campusId: await findCampusId(database, input.campus),
      }
      if (input.password) {
        const password = requireText(input.password, 'Password')
        if (password.length < 8) throw new HttpError(400, 'Password must contain at least 8 characters.')
        fields.passwordHash = hashPassword(password)
      }
      break
    }
    case 'departments': {
      const academicYearIds = await validateAcademicYearIds(database, input.academicYearIds)
      const removedYearIds = (current.academicYearIds || []).filter((yearId) => !academicYearIds.includes(yearId))
      for (const yearId of removedYearIds) {
        if (await database.collection('batches').countDocuments({ departmentId: current.id, academicYearId: yearId })) {
          throw new HttpError(409, 'Move or delete this department’s batches before removing an academic year.')
        }
        if (await database.collection('subjects').countDocuments({ departmentId: current.id, academicYearId: yearId })) {
          throw new HttpError(409, 'Move or delete this department’s subjects before removing an academic year.')
        }
      }
      fields = {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        academicYearIds, campusId: await findCampusId(database, input.campus), head: input.head?.trim() || '',
      }
      break
    }
    case 'programs': {
      const department = await findActiveRecord(database, 'departments', input.departmentId, 'Department')
      if (department.id !== current.departmentId) {
        const references = await Promise.all([
          database.collection('batches').countDocuments({ programId: current.id }),
          database.collection('users').countDocuments({ programId: current.id }),
          database.collection('schedules').countDocuments({ programId: current.id }),
          database.collection('subjects').countDocuments({ programId: current.id }),
        ])
        if (references.some(Boolean)) throw new HttpError(409, 'This program cannot change departments while batches, users, or schedules reference it.')
      }
      fields = {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        departmentId: department.id, level: requireText(input.level, 'Award level'),
      }
      break
    }
    case 'batches': {
      const academicYear = await findActiveRecord(database, 'academic_years', input.academicYearId, 'Academic year')
      const department = await findActiveRecord(database, 'departments', input.departmentId, 'Department')
      const program = await findActiveRecord(database, 'programs', input.programId, 'Program')
      if (program.departmentId !== department.id) throw new HttpError(400, 'Choose a program in the selected department.')
      if (!(department.academicYearIds || []).includes(academicYear.id)) throw new HttpError(400, 'The selected department is not offered in this academic year.')
      const hasSemesters = await database.collection('semesters').countDocuments({ batchId: current.id })
      const hasSubjects = await database.collection('subjects').countDocuments({ batchId: current.id })
      if ((hasSemesters || hasSubjects) && (current.academicYearId !== academicYear.id || current.departmentId !== department.id || current.programId !== program.id)) {
        throw new HttpError(409, 'Move or delete this batch’s semesters before changing its parent records.')
      }
      fields = {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        academicYearId: academicYear.id, departmentId: department.id, programId: program.id,
      }
      break
    }
    case 'semesters': {
      const batch = await findActiveRecord(database, 'batches', input.batchId, 'Batch')
      const hasChildren = await database.collection('sections').countDocuments({ semesterId: current.id })
        || await database.collection('subjects').countDocuments({ semesterId: current.id })
      if (batch.id !== current.batchId && hasChildren) {
        throw new HttpError(409, 'Move or delete this semester’s sections before changing its batch.')
      }
      const { startDate, endDate } = validateDateRange(input.startDate, input.endDate, 'Semester')
      const academicYear = await database.collection('academic_years').findOne({ id: batch.academicYearId })
      if (startDate && academicYear?.startDate && (startDate < academicYear.startDate || endDate > academicYear.endDate)) {
        throw new HttpError(400, 'Semester dates must fall within the academic year.')
      }
      fields = { name: requireText(input.name, 'Semester name'), batchId: batch.id, startDate, endDate }
      break
    }
    case 'sections': {
      const semester = await findActiveRecord(database, 'semesters', input.semesterId, 'Semester')
      fields = {
        name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(),
        semesterId: semester.id,
      }
      break
    }
    case 'campuses':
      fields = { name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(), location: input.location?.trim() || '' }
      break
    case 'rooms':
      fields = { name: requireText(input.name, 'Name'), code: requireText(input.code, 'Code').toUpperCase(), campusId: await findCampusId(database, input.campus), capacity: validateRoomCapacity(input.capacity), type: requireText(input.type, 'Room type') }
      break
    default: throw new HttpError(404, 'Unknown system directory.')
  }
  await database.collection(config.collection).updateOne(byId(id), { $set: fields })
}

export async function createSystemEntity(database, user, entity, input) {
  const config = getEntityConfig(entity)
  const id = await insertEntity(database, entity, input)
  const record = await getSystemEntity(database, entity, id)
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: `Created ${config.singular}`, target: record.name || record.email, details: `${config.singular} added to the system` })
  return record
}

export async function updateSystemEntity(database, user, entity, id, input) {
  const config = getEntityConfig(entity)
  const before = await getSystemEntity(database, entity, id)
  await updateEntity(database, entity, id, input)
  const record = await getSystemEntity(database, entity, id)
  if (entity === 'academic-years' && before.name !== record.name) {
    await database.collection('system_settings').updateOne(
      { key: 'academicYear', value: before.name }, { $set: { value: record.name } },
    )
  }
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: `Updated ${config.singular}`, target: record.name || record.email, details: `${config.singular} details saved` })
  return record
}

export async function setSystemEntityStatus(database, user, entity, id, status) {
  const config = getEntityConfig(entity)
  if (!['Active', 'Inactive'].includes(status)) throw new HttpError(400, 'Status must be Active or Inactive.')
  const before = await getSystemEntity(database, entity, id)
  if (status === 'Inactive') {
    const dependencies = {
      'academic-years': [['departments', { academicYearIds: before.id, status: 'Active' }], ['batches', { academicYearId: before.id, status: 'Active' }], ['subjects', { academicYearId: before.id, status: 'Active' }]],
      departments: [['programs', { departmentId: before.id, status: 'Active' }], ['batches', { departmentId: before.id, status: 'Active' }], ['subjects', { departmentId: before.id, status: 'Active' }]],
      programs: [['batches', { programId: before.id, status: 'Active' }], ['subjects', { programId: before.id, status: 'Active' }]],
      batches: [['semesters', { batchId: before.id, status: 'Active' }], ['subjects', { batchId: before.id, status: 'Active' }]],
      semesters: [['sections', { semesterId: before.id, status: 'Active' }], ['subjects', { semesterId: before.id, status: 'Active' }]],
    }[entity] || []
    for (const [collectionName, filter] of dependencies) {
      if (await database.collection(collectionName).countDocuments(filter)) {
        throw new HttpError(409, `Deactivate this ${config.singular}’s active descendants first.`)
      }
    }
    if (entity === 'academic-years') {
      const currentYear = await database.collection('system_settings').findOne({ key: 'academicYear', value: before.name })
      if (currentYear) throw new HttpError(409, 'Choose a different current academic year before deactivating this one.')
    }
  } else {
    const parents = {
      departments: async () => database.collection('academic_years').countDocuments({ id: { $in: before.academicYearIds || [] }, status: 'Active' }),
      programs: async () => database.collection('departments').countDocuments({ id: before.departmentId, status: 'Active' }),
      batches: async () => database.collection('batches').countDocuments({ id: before.id }),
      semesters: async () => database.collection('batches').countDocuments({ id: before.batchId, status: 'Active' }),
      sections: async () => database.collection('semesters').countDocuments({ id: before.semesterId, status: 'Active' }),
    }[entity]
    if (parents && !(await parents())) throw new HttpError(409, 'Activate this record’s parent first.')
    if (entity === 'batches') {
      const validParents = await Promise.all([
        database.collection('academic_years').countDocuments({ id: before.academicYearId, status: 'Active' }),
        database.collection('departments').countDocuments({ id: before.departmentId, status: 'Active', academicYearIds: before.academicYearId }),
        database.collection('programs').countDocuments({ id: before.programId, status: 'Active', departmentId: before.departmentId }),
      ])
      if (validParents.some((count) => count === 0)) throw new HttpError(409, 'Activate this record’s parent first.')
    }
    if (entity === 'subjects') await validateSubjectInput(database, before)
  }
  if (entity === 'users' && before.role === 'Faculty' && status === 'Inactive'
    && await database.collection('subjects').countDocuments({ facultyId: before.id, status: 'Active' })) {
    throw new HttpError(409, 'Reassign this faculty member’s active subjects before deactivating the account.')
  }
  await database.collection(config.collection).updateOne(byId(id), { $set: { status } })
  const record = await getSystemEntity(database, entity, id)
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: `${status === 'Active' ? 'Activated' : 'Deactivated'} ${config.singular}`, target: record.name || record.email, details: `Status changed from ${before.status} to ${status}` })
  return record
}

export async function deleteSystemEntity(database, user, entity, id) {
  const config = getEntityConfig(entity)
  if (!config.structure) throw new HttpError(403, 'Deletion is not available for this system directory.')
  const record = await getSystemEntity(database, entity, id)
  const references = {
    'academic-years': [
      ['departments', { academicYearIds: record.id }], ['batches', { academicYearId: record.id }],
      ['subjects', { academicYearId: record.id }],
      ['system_settings', { key: 'academicYear', value: record.name }],
    ],
    departments: [
      ['programs', { departmentId: record.id }], ['batches', { departmentId: record.id }],
      ['users', { departmentId: record.id }], ['schedules', { departmentId: record.id }], ['subjects', { departmentId: record.id }],
    ],
    programs: [
      ['batches', { programId: record.id }], ['users', { programId: record.id }], ['schedules', { programId: record.id }], ['subjects', { programId: record.id }],
    ],
    batches: [['semesters', { batchId: record.id }], ['subjects', { batchId: record.id }]],
    semesters: [['sections', { semesterId: record.id }], ['subjects', { semesterId: record.id }]],
    subjects: [['schedules', { subjectId: record.id }]],
    sections: [],
  }[entity]
  for (const [collectionName, filter] of references) {
    if (await database.collection(collectionName).countDocuments(filter)) {
      throw new HttpError(409, `This ${config.singular} is still referenced and cannot be deleted.`)
    }
  }
  await database.collection(config.collection).deleteOne(byId(record.id))
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: `Deleted ${config.singular}`, target: record.name || record.code, details: `${config.singular} removed from the system` })
  return { id: record.id, deleted: true }
}

export async function getSystemSettings(database) {
  const settings = await database.collection('system_settings').find().toArray()
  return Object.fromEntries(settings.map(({ key, value }) => [key, value]))
}

export async function saveSystemSettings(database, user, input) {
  const current = await getSystemSettings(database)
  const next = {
    institutionName: requireText(input.institutionName, 'Institution name'), academicYear: requireText(input.academicYear, 'Academic year'),
    semester: requireText(input.semester, 'Semester'), timeZone: requireText(input.timeZone, 'Time zone'),
    conflictDetection: Boolean(input.conflictDetection), userRegistration: Boolean(input.userRegistration), auditRetention: Number(input.auditRetention),
  }
  if (!Number.isInteger(next.auditRetention) || next.auditRetention < 30 || next.auditRetention > 3650) throw new HttpError(400, 'Audit retention must be between 30 and 3650 days.')
  const academicYear = await database.collection('academic_years').findOne({ name: next.academicYear, status: 'Active' })
  if (!academicYear) throw new HttpError(400, 'Choose an active academic year from the academic structure.')
  await database.collection('system_settings').bulkWrite(Object.entries(next).map(([key, value]) => ({
    updateOne: { filter: { key }, update: { $set: { value } }, upsert: true },
  })))
  await writeAudit(database, { actorId: user.id, actorName: user.name, action: 'Updated system settings', target: 'System configuration', details: `${current.academicYear} → ${next.academicYear}` })
  return next
}

export async function getSystemOverview(database) {
  const records = Object.fromEntries(await Promise.all(Object.keys(entities).map(async (entity) => [entity, await listSystemEntities(database, entity)])))
  const activeUsers = records.users.filter((user) => user.status === 'Active').length
  const activeRooms = records.rooms.filter((room) => room.status === 'Active').length
  return {
    records,
    metrics: { activeUsers, totalUsers: records.users.length, departments: records.departments.length, programs: records.programs.length, campuses: records.campuses.length, activeRooms },
    audit: await listAudit(database, 5),
  }
}

export async function getSystemAnalytics(database) {
  const overview = await getSystemOverview(database)
  const programs = await database.collection('programs').find().toArray()
  const programCounts = new Map()
  for (const program of programs) programCounts.set(program.departmentId, (programCounts.get(program.departmentId) || 0) + 1)
  const programsByDepartment = overview.records.departments.map((department) => ({
    name: department.name, count: programCounts.get(department.id) || 0,
  }))
  const activeRooms = overview.records.rooms.filter((room) => room.status === 'Active')
  const auditEvents = await database.collection('audit_logs').countDocuments()
  return {
    users: { total: overview.metrics.totalUsers, active: overview.metrics.activeUsers, inactive: overview.metrics.totalUsers - overview.metrics.activeUsers },
    departments: overview.metrics.departments, programs: overview.metrics.programs, campuses: overview.metrics.campuses,
    rooms: { active: activeRooms.length, capacity: activeRooms.reduce((sum, room) => sum + Number(room.capacity), 0) },
    programsByDepartment, auditEvents,
  }
}

export async function getSystemAudit(database, limit = 200) {
  return listAudit(database, Math.max(1, Math.min(500, Number(limit) || 200)))
}
