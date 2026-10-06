import { MongoClient } from 'mongodb'
import { hashPassword } from '../utils/passwords.js'

const uri = process.env.MONGODB_URI
let client

export async function connectDatabase(connectionString = uri) {
  if (!connectionString) throw new Error('MONGODB_URI must be set before starting the API.')
  client = new MongoClient(connectionString)
  await client.connect()
  const databaseName = new URL(connectionString.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('/')[0]
  const database = client.db(databaseName || 'timetable_allocation')
  await initializeDatabase(database)
  return database
}

export async function closeDatabase() {
  await client?.close()
  client = undefined
}

export async function nextId(database, collectionName) {
  const counter = await database.collection('counters').findOneAndUpdate(
    { _id: collectionName },
    { $inc: { sequence: 1 } },
    { upsert: true, returnDocument: 'after' },
  )
  return counter.sequence
}

async function insertSeed(database, collectionName, document) {
  const id = await nextId(database, collectionName)
  await database.collection(collectionName).insertOne({ id, ...document, createdAt: new Date() })
  return id
}

async function seedDatabase(database) {
  const seedPassword = process.env.SEED_PASSWORD
  if (process.env.NODE_ENV === 'production' && !seedPassword) {
    throw new Error('Set SEED_PASSWORD before starting production with an empty database.')
  }
  const passwordHash = hashPassword(seedPassword || 'CampusDemo!2026')
  const mainCampusId = await insertSeed(database, 'campuses', { name: 'Main Campus', code: 'MAIN', location: 'Central District', status: 'Active' })
  const northCampusId = await insertSeed(database, 'campuses', { name: 'North Campus', code: 'NORTH', location: 'North Ridge', status: 'Active' })
  const computerScienceId = await insertSeed(database, 'departments', { name: 'Computer Science', code: 'CSC', campusId: mainCampusId, head: 'Dr. Mensah', status: 'Active' })
  const electricalEngineeringId = await insertSeed(database, 'departments', { name: 'Electrical Engineering', code: 'EEE', campusId: northCampusId, head: 'Dr. Nwosu', status: 'Active' })
  const businessStudiesId = await insertSeed(database, 'departments', { name: 'Business Studies', code: 'BUS', campusId: mainCampusId, head: 'Dr. Okeke', status: 'Active' })
  const computerScienceProgramId = await insertSeed(database, 'programs', { name: 'Computer Science', code: 'BSC-CS', departmentId: computerScienceId, level: 'Bachelor', status: 'Active' })
  await insertSeed(database, 'programs', { name: 'Information Systems', code: 'BSC-IS', departmentId: computerScienceId, level: 'Bachelor', status: 'Active' })
  await insertSeed(database, 'programs', { name: 'Electrical Engineering', code: 'BENG-EE', departmentId: electricalEngineeringId, level: 'Bachelor', status: 'Active' })
  await insertSeed(database, 'programs', { name: 'Business Administration', code: 'MBA', departmentId: businessStudiesId, level: 'Master', status: 'Active' })

  const userSeeds = [
    ['Alex Student', 'student@demo.edu', 'student', computerScienceId, mainCampusId, '', true],
    ['Dr. Mensah', 'faculty@demo.edu', 'faculty', computerScienceId, mainCampusId, 'Monday,Wednesday,Friday', true],
    ['Dr. Bello', 'bello@demo.edu', 'faculty', computerScienceId, mainCampusId, 'Tuesday,Thursday', true],
    ['Eng. Adeyemi', 'adeyemi@demo.edu', 'faculty', electricalEngineeringId, northCampusId, 'Monday,Tuesday,Thursday', false],
    ['Eng. Nwosu', 'nwosu@demo.edu', 'faculty', electricalEngineeringId, northCampusId, 'Tuesday,Wednesday,Friday', true],
    ['Dr. Okeke', 'okeke@demo.edu', 'faculty', businessStudiesId, mainCampusId, 'Monday,Wednesday,Friday', true],
    ['Department Administrator', 'department.admin@demo.edu', 'department-admin', computerScienceId, mainCampusId, '', true],
    ['Academic Administrator', 'academic.admin@demo.edu', 'academic-admin', null, mainCampusId, '', true],
    ['System Administrator', 'super.admin@demo.edu', 'super-admin', null, mainCampusId, '', true],
  ]
  const users = {}
  for (const [name, email, role, departmentId, campusId, availabilityDays, available] of userSeeds) {
    users[email] = await insertSeed(database, 'users', {
      name, email, passwordHash, role, departmentId, campusId,
      programId: email === 'student@demo.edu' ? computerScienceProgramId : null,
      cohort: email === 'student@demo.edu' ? 'Year 2 · Group A' : '',
      availabilityDays, available, status: 'Active',
    })
  }

  const roomSeeds = [
    ['Room A201', 'A201', mainCampusId, 60, 'Classroom'], ['Computing Lab 1', 'CL-101', mainCampusId, 36, 'Laboratory'],
    ['Lecture Hall B', 'LH-B01', mainCampusId, 140, 'Lecture hall'], ['Design Studio', 'DS-201', northCampusId, 28, 'Studio'],
    ['Room C104', 'C104', northCampusId, 44, 'Classroom'], ['Seminar Room 2', 'SR-202', northCampusId, 42, 'Meeting room'],
    ['Lecture Hall A', 'LH-A01', mainCampusId, 180, 'Lecture hall'], ['Computing Lab 2', 'CL-102', mainCampusId, 34, 'Laboratory'],
    ['Room B106', 'B106', northCampusId, 48, 'Classroom'], ['Innovation Hub', 'IH-001', mainCampusId, 32, 'Studio'],
    ['Engineering Lab', 'EL-001', northCampusId, 40, 'Laboratory'],
  ]
  const rooms = {}
  for (const [name, code, campusId, capacity, type] of roomSeeds) {
    rooms[name] = await insertSeed(database, 'rooms', { name, code, campusId, capacity, type, status: 'Active' })
  }

  const scheduleSeeds = [
    [computerScienceId, computerScienceProgramId, 'Monday', '08:30', '09:45', 'Discrete Mathematics', 'MTH 204', users['faculty@demo.edu'], rooms['Room A201'], 'Year 2 · Group A', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Monday', '11:00', '12:30', 'Programming II', 'CSC 220', users['faculty@demo.edu'], rooms['Computing Lab 1'], 'Year 2 · Group A', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Tuesday', '09:00', '10:15', 'Database Systems', 'CSC 310', users['bello@demo.edu'], rooms['Lecture Hall B'], 'Year 3 · Group B', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Tuesday', '13:00', '14:30', 'Interface Design', 'DES 215', users['faculty@demo.edu'], rooms['Design Studio'], 'Year 2 · Group A', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Wednesday', '09:30', '10:45', 'Algorithms', 'CSC 305', users['faculty@demo.edu'], rooms['Room C104'], 'Year 3 · Group B', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Wednesday', '12:00', '13:30', 'Research Methods', 'RES 201', users['bello@demo.edu'], rooms['Seminar Room 2'], 'Year 2 · Group A', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Thursday', '10:00', '11:15', 'Operating Systems', 'CSC 315', users['bello@demo.edu'], rooms['Lecture Hall A'], 'Year 3 · Group B', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Thursday', '13:30', '15:00', 'Web Technologies', 'CSC 230', users['faculty@demo.edu'], rooms['Computing Lab 2'], 'Year 2 · Group A', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Friday', '09:00', '10:30', 'Networks & Security', 'CSC 320', users['faculty@demo.edu'], rooms['Room B106'], 'Year 3 · Group B', 'Published'],
    [computerScienceId, computerScienceProgramId, 'Friday', '12:30', '14:00', 'Project Workshop', 'CSC 298', users['bello@demo.edu'], rooms['Innovation Hub'], 'Year 2 · Group A', 'Published'],
    [electricalEngineeringId, null, 'Monday', '08:30', '09:45', 'Circuit Analysis', 'EEE 201', users['adeyemi@demo.edu'], rooms['Room A201'], 'Year 2 · Group A', 'Awaiting approval'],
    [electricalEngineeringId, null, 'Tuesday', '11:00', '12:15', 'Digital Systems', 'EEE 304', users['nwosu@demo.edu'], rooms['Engineering Lab'], 'Year 3 · Group B', 'Draft'],
    [businessStudiesId, null, 'Wednesday', '09:30', '10:45', 'Operations Management', 'BUS 220', users['okeke@demo.edu'], rooms['Room C104'], 'Year 2 · Group A', 'Awaiting approval'],
  ]
  for (const [departmentId, programId, day, start, end, subject, code, facultyId, roomId, cohort, status] of scheduleSeeds) {
    await insertSeed(database, 'schedules', { departmentId, programId, day, start, end, subject, code, facultyId, roomId, cohort, status, createdBy: null })
  }

  const conflictSeeds = [
    ['Room overlap', 'Monday', '08:30', '09:45', 'Room A201 is assigned to two classes.', 'Discrete Mathematics · Circuit Analysis', null, true],
    ['Room overlap', 'Wednesday', '09:30', '10:45', 'Room C104 is assigned to two classes.', 'Algorithms · Operations Management', null, true],
    ['Faculty availability', 'Tuesday', '09:00', '10:15', 'Faculty member is unavailable at this time.', 'Database Systems · Dr. Bello', computerScienceId, false],
  ]
  for (const [type, day, start, end, detail, scheduleNames, departmentId, isCrossDepartment] of conflictSeeds) {
    await insertSeed(database, 'conflicts', { type, day, start, end, detail, schedules: scheduleNames, departmentId, isCrossDepartment, status: 'Open' })
  }

  await Promise.all(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, index) =>
    database.collection('working_days').insertOne({ day, enabled: index < 5, order: index })))
  const slots = [['08:00', '09:00'], ['09:00', '10:00'], ['10:30', '11:30'], ['11:30', '12:30']]
  for (const [start, end] of slots) await insertSeed(database, 'time_slots', { start, end })
  const settings = {
    institutionName: 'Timetable Allocation & Management Portal', academicYear: '2026/2027', semester: 'First semester',
    timeZone: 'Africa/Lagos', conflictDetection: true, userRegistration: false, auditRetention: 365,
  }
  for (const [key, value] of Object.entries(settings)) await database.collection('system_settings').insertOne({ key, value })
  await insertSeed(database, 'audit_logs', { actorId: null, actorName: 'Academic Administrator', action: 'Published timetable', target: 'Computer Science', details: 'Semester 1 timetable published' })
  await insertSeed(database, 'audit_logs', { actorId: null, actorName: 'System', action: 'Resolved scheduling conflict', target: 'Lecture Hall A', details: 'Room overlap cleared for Tuesday' })
}

export async function initializeDatabase(database) {
  const uniqueIndexes = {
    campuses: ['name', 'code'], departments: ['name', 'code'], programs: ['code'], academic_years: ['name'],
    users: ['email'], rooms: ['code'], subjects: ['code'], system_settings: ['key'], working_days: ['day'],
  }
  await Promise.all(Object.entries(uniqueIndexes).flatMap(([collection, fields]) =>
    fields.map((field) => database.collection(collection).createIndex({ [field]: 1 }, { unique: true }))))
  await Promise.all([
    database.collection('users').createIndex({ facultyCode: 1 }, { unique: true, sparse: true }),
    database.collection('schedules').createIndex({ departmentId: 1, day: 1, start: 1 }),
    database.collection('schedules').createIndex({ entrySource: 1, sectionId: 1, day: 1, start: 1 }),
    database.collection('schedules').createIndex({ versionId: 1, sectionId: 1, day: 1, start: 1 }),
    database.collection('schedules').createIndex({ facultyId: 1, day: 1, status: 1 }),
    database.collection('schedules').createIndex({ programId: 1, cohort: 1, status: 1 }),
    database.collection('conflicts').createIndex({ status: 1, departmentId: 1 }),
    database.collection('audit_logs').createIndex({ id: -1 }),
    database.collection('notifications').createIndex({ userId: 1, createdAt: -1 }),
    database.collection('leave_requests').createIndex({ facultyId: 1, createdAt: -1 }),
    database.collection('users').createIndex({ role: 1, 'availableSlots.day': 1 }),
    database.collection('users').createIndex({ role: 1, 'unavailableSlots.day': 1 }),
    database.collection('time_slots').createIndex({ day: 1, sequence: 1, status: 1 }),
    database.collection('timetable_versions').createIndex({ academicYearId: 1, departmentId: 1, programId: 1, batchId: 1, semesterId: 1, sectionId: 1, versionNumber: 1 }, { unique: true }),
    database.collection('batches').createIndex({ academicYearId: 1, programId: 1, code: 1 }, { unique: true }),
    database.collection('semesters').createIndex({ batchId: 1, name: 1 }, { unique: true }),
    database.collection('sections').createIndex({ semesterId: 1, code: 1 }, { unique: true }),
    database.collection('subjects').createIndex({ academicYearId: 1, departmentId: 1, programId: 1, semesterId: 1, status: 1 }),
  ])
  if (await database.collection('users').countDocuments() === 0) await seedDatabase(database)
  await ensureAcademicStructure(database)
  await ensureFacultyProfiles(database)
  await ensureTimeSlots(database)
  await ensureManualTimetableStructure(database)
  return database
}

async function ensureTimeSlots(database) {
  const currentSlots = await database.collection('time_slots').find().sort({ start: 1 }).toArray()
  if (!currentSlots.length) return

  const slotsByDay = new Map()
  for (const slot of currentSlots) {
    if (slot.day) {
      const daySlots = slotsByDay.get(slot.day) || []
      daySlots.push(slot)
      slotsByDay.set(slot.day, daySlots)
    }
  }

  const legacySlots = currentSlots.filter((slot) => !slot.day)
  if (legacySlots.length) {
    let days = await database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray()
    if (!days.length) days = await database.collection('working_days').find().sort({ order: 1 }).toArray()
    if (!days.length) days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => ({ day }))
    for (const { day } of days) slotsByDay.set(day, [...(slotsByDay.get(day) || []), ...legacySlots])
    await database.collection('time_slots').deleteMany({})
  }

  for (const [day, daySlots] of slotsByDay) {
    daySlots.sort((left, right) => (left.sequence || Infinity) - (right.sequence || Infinity) || left.start.localeCompare(right.start))
    for (const [index, slot] of daySlots.entries()) {
      const id = slot.day ? slot.id : await nextId(database, 'time_slots')
      const normalized = {
        id, day,
        start: slot.start, end: slot.end, type: slot.type || 'CLASS', sequence: index + 1,
        status: slot.status || 'Active', createdAt: slot.createdAt || new Date(),
      }
      if (legacySlots.length) await database.collection('time_slots').insertOne(normalized)
      else await database.collection('time_slots').updateOne({ id: slot.id }, { $set: normalized })
    }
  }
}

async function ensureFacultyProfiles(database) {
  const [faculty, timeSlots] = await Promise.all([
    database.collection('users').find({ role: 'faculty' }).toArray(),
    database.collection('time_slots').find().sort({ start: 1 }).toArray(),
  ])
  const subjectAssignments = faculty.length
    ? await database.collection('subjects').find({ facultyId: { $in: faculty.map((item) => item.id) } }).toArray()
    : []
  const subjectsByFaculty = new Map()
  for (const subject of subjectAssignments) {
    const ids = subjectsByFaculty.get(subject.facultyId) || []
    ids.push(subject.id)
    subjectsByFaculty.set(subject.facultyId, ids)
  }

  for (const item of faculty) {
    const updates = {}
    if (!item.facultyCode) updates.facultyCode = `FAC-${String(item.id).padStart(4, '0')}`
    if (!item.designation) updates.designation = 'Faculty'
    if (!Number.isInteger(item.maxTeachingHours)) updates.maxTeachingHours = 20
    if (!Array.isArray(item.subjectIds)) updates.subjectIds = subjectsByFaculty.get(item.id) || []
    if (!Array.isArray(item.sectionIds)) updates.sectionIds = []
    if (!Array.isArray(item.availableSlots)) {
      const days = String(item.availabilityDays || '').split(',').map((day) => day.trim()).filter(Boolean)
      updates.availableSlots = days.flatMap((day) => timeSlots.map(({ start, end }) => ({ day, start, end })))
    }
    if (!Array.isArray(item.unavailableSlots)) updates.unavailableSlots = []
    if (!Array.isArray(item.preferredSlots)) updates.preferredSlots = []
    if (Object.keys(updates).length) await database.collection('users').updateOne({ id: item.id }, { $set: updates })
  }
}

async function ensureManualTimetableStructure(database) {
  // Seed a demo academic hierarchy (batch/semester/section/subjects) so the Manual
  // Timetable workflow — validate and generate draft — works on a fresh database.
  const [existingBatches, existingSemesters, existingSections, existingSubjects] = await Promise.all([
    database.collection('batches').countDocuments(),
    database.collection('semesters').countDocuments(),
    database.collection('sections').countDocuments(),
    database.collection('subjects').countDocuments(),
  ])
  if (existingBatches || existingSemesters || existingSections || existingSubjects) return

  const academicYear = await database.collection('academic_years').findOne({ status: 'Active' }, { sort: { id: 1 } })
  if (!academicYear) return
  const [departments, programs, classSlots] = await Promise.all([
    database.collection('departments').find({ status: 'Active' }).toArray(),
    database.collection('programs').find({ status: 'Active' }).toArray(),
    database.collection('time_slots').find({ type: 'CLASS', status: 'Active' }).toArray(),
  ])
  if (!departments.length || !programs.length || !classSlots.length) return

  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
  const durations = [...new Set(classSlots
    .map((slot) => toMinutes(slot.end) - toMinutes(slot.start))
    .filter((value) => Number.isFinite(value) && value > 0))]
  if (!durations.length) return

  // Smallest whole-hour weekly load the configured slot grid can fill exactly
  // (60-minute grid -> 1h, 75-minute grid -> 5h).
  let weeklyHours = 0
  for (let hours = 1; hours <= 40 && !weeklyHours; hours += 1) {
    const target = hours * 60
    const reachable = new Set([0])
    for (let total = 1; total <= target; total += 1) {
      for (const duration of durations) {
        if (total >= duration && reachable.has(total - duration)) {
          reachable.add(total)
          break
        }
      }
    }
    if (reachable.has(target)) weeklyHours = hours
  }
  if (!weeklyHours) return
  const subjectCount = weeklyHours <= 2 ? 2 : 1
  const departmentsById = new Map(departments.map((item) => [item.id, item]))

  for (const program of programs) {
    const department = departmentsById.get(program.departmentId)
    if (!department || !(department.academicYearIds || []).includes(academicYear.id)) continue
    const batchId = await nextId(database, 'batches')
    await database.collection('batches').insertOne({
      id: batchId, name: 'Year 1', code: 'Y1', academicYearId: academicYear.id,
      departmentId: department.id, programId: program.id, status: 'Active', createdAt: new Date(),
    })
    const semesterId = await nextId(database, 'semesters')
    await database.collection('semesters').insertOne({
      id: semesterId, name: 'First Semester', batchId, startDate: '', endDate: '',
      status: 'Active', createdAt: new Date(),
    })
    const sectionId = await nextId(database, 'sections')
    await database.collection('sections').insertOne({
      id: sectionId, name: 'Section A', code: 'A', semesterId, status: 'Active', createdAt: new Date(),
    })
    for (let index = 1; index <= subjectCount; index += 1) {
      const subjectId = await nextId(database, 'subjects')
      await database.collection('subjects').insertOne({
        id: subjectId, code: `${program.code} 10${index}`,
        name: index === 1 ? `${program.name} Foundations` : `${program.name} Applications`,
        credits: 3, type: 'Core', academicYearId: academicYear.id, departmentId: department.id,
        programId: program.id, batchId, semesterId,
        weeklyHours, theoryHours: weeklyHours, practicalHours: 0,
        facultyId: null, requiresLab: false, status: 'Active', createdAt: new Date(),
      })
    }
  }
}

async function ensureAcademicStructure(database) {
  const currentYearSetting = await database.collection('system_settings').findOne({ key: 'academicYear' })
  const name = typeof currentYearSetting?.value === 'string' && currentYearSetting.value.trim()
    ? currentYearSetting.value.trim()
    : '2026/2027'
  let academicYear = await database.collection('academic_years').findOne({ name })
  if (!academicYear) {
    const id = await nextId(database, 'academic_years')
    await database.collection('academic_years').insertOne({ id, name, status: 'Active', createdAt: new Date() })
    academicYear = { id, name }
  }

  await database.collection('departments').updateMany(
    { $or: [{ academicYearIds: { $exists: false } }, { academicYearIds: { $size: 0 } }] },
    { $set: { academicYearIds: [academicYear.id] } },
  )
}
