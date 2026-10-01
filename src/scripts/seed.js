import { MongoClient } from 'mongodb'
import crypto from 'crypto'

function hashPassword(password) {
  const salt = 'timetable-static-salt'
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')
}

const connectionString = process.env.MONGODB_URI
if (!connectionString) {
  console.error('Error: MONGODB_URI environment variable is not set.')
  process.exit(1)
}

async function seed() {
  console.log('Connecting to MongoDB Atlas...')
  const client = new MongoClient(connectionString)
  await client.connect()

  const dbName = new URL(connectionString.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('/')[0] || 'timetable_allocation'
  const db = client.db(dbName)
  console.log(`Connected to database: "${dbName}"`)

  // Collections to wipe before seeding fresh demo data
  const collections = [
    'campuses', 'departments', 'programs', 'academic_years', 'batches', 'semesters',
    'sections', 'subjects', 'users', 'rooms', 'schedules', 'timetable_versions',
    'conflicts', 'working_days', 'time_slots', 'system_settings', 'audit_logs',
    'notifications', 'counters'
  ]

  for (const name of collections) {
    await db.collection(name).deleteMany({})
  }
  console.log('Cleared existing collections.')

  const counterSeq = {}
  async function nextId(collectionName) {
    counterSeq[collectionName] = (counterSeq[collectionName] || 0) + 1
    await db.collection('counters').updateOne(
      { _id: collectionName },
      { $set: { sequence: counterSeq[collectionName] } },
      { upsert: true }
    )
    return counterSeq[collectionName]
  }

  async function insert(collectionName, doc) {
    const id = await nextId(collectionName)
    const record = { id, ...doc, createdAt: new Date() }
    await db.collection(collectionName).insertOne(record)
    return id
  }

  const seedPassword = process.env.SEED_PASSWORD || 'CampusDemo!2026'
  const passwordHash = hashPassword(seedPassword)

  console.log('Seeding Campuses...')
  const mainCampusId = await insert('campuses', { name: 'Main Campus', code: 'MAIN', location: 'Central District', status: 'Active' })
  const northCampusId = await insert('campuses', { name: 'North Campus', code: 'NORTH', location: 'North Ridge', status: 'Active' })
  const techCampusId = await insert('campuses', { name: 'Science & Tech Park', code: 'STP', location: 'Innovation Valley', status: 'Active' })

  console.log('Seeding Departments...')
  const csDeptId = await insert('departments', { name: 'Computer Science', code: 'CSC', campusId: mainCampusId, head: 'Dr. Mensah', status: 'Active' })
  const eeeDeptId = await insert('departments', { name: 'Electrical Engineering', code: 'EEE', campusId: northCampusId, head: 'Dr. Nwosu', status: 'Active' })
  const busDeptId = await insert('departments', { name: 'Business Studies', code: 'BUS', campusId: mainCampusId, head: 'Dr. Okeke', status: 'Active' })
  const itDeptId = await insert('departments', { name: 'Information Technology', code: 'IT', campusId: techCampusId, head: 'Dr. Grace Hopper', status: 'Active' })
  const mecDeptId = await insert('departments', { name: 'Mechanical Engineering', code: 'MEC', campusId: northCampusId, head: 'Eng. Adeyemi', status: 'Active' })

  console.log('Seeding Programs...')
  const csProgId = await insert('programs', { name: 'B.Tech Computer Science', code: 'BSC-CS', departmentId: csDeptId, level: 'Bachelor', status: 'Active' })
  const itProgId = await insert('programs', { name: 'B.Tech Information Systems', code: 'BSC-IS', departmentId: csDeptId, level: 'Bachelor', status: 'Active' })
  const eeProgId = await insert('programs', { name: 'B.Tech Electrical Engineering', code: 'BENG-EE', departmentId: eeeDeptId, level: 'Bachelor', status: 'Active' })
  const mbaProgId = await insert('programs', { name: 'Master of Business Administration', code: 'MBA', departmentId: busDeptId, level: 'Master', status: 'Active' })
  const mecProgId = await insert('programs', { name: 'B.Tech Mechanical Engineering', code: 'BENG-ME', departmentId: mecDeptId, level: 'Bachelor', status: 'Active' })

  console.log('Seeding Users (Faculty, Students, Admins)...')
  const userSeeds = [
    // Students
    ['Alex Student', 'student@demo.edu', 'student', csDeptId, mainCampusId, csProgId, 'Year 2 · Group A', '', true],
    ['John Doe', 'john.doe@demo.edu', 'student', csDeptId, mainCampusId, csProgId, 'Year 1 · Group A', '', true],
    ['Emily Smith', 'emily.smith@demo.edu', 'student', csDeptId, mainCampusId, csProgId, 'Year 2 · Group B', '', true],
    ['Michael Brown', 'michael.brown@demo.edu', 'student', itDeptId, techCampusId, itProgId, 'Year 3 · Group A', '', true],
    ['Jessica Taylor', 'jessica.taylor@demo.edu', 'student', eeeDeptId, northCampusId, eeProgId, 'Year 2 · Group A', '', true],
    ['David Wilson', 'david.wilson@demo.edu', 'student', busDeptId, mainCampusId, mbaProgId, 'Year 1 · Group A', '', true],

    // Faculty members
    ['Dr. Mensah', 'faculty@demo.edu', 'faculty', csDeptId, mainCampusId, null, '', 'Monday,Wednesday,Friday', true],
    ['Dr. Bello', 'bello@demo.edu', 'faculty', csDeptId, mainCampusId, null, '', 'Tuesday,Thursday', true],
    ['Prof. Alan Turing', 'turing@demo.edu', 'faculty', csDeptId, mainCampusId, null, '', 'Monday,Tuesday,Wednesday', true],
    ['Dr. Ada Lovelace', 'lovelace@demo.edu', 'faculty', csDeptId, mainCampusId, null, '', 'Wednesday,Thursday,Friday', true],
    ['Eng. Adeyemi', 'adeyemi@demo.edu', 'faculty', eeeDeptId, northCampusId, null, '', 'Monday,Tuesday,Thursday', true],
    ['Eng. Nwosu', 'nwosu@demo.edu', 'faculty', eeeDeptId, northCampusId, null, '', 'Tuesday,Wednesday,Friday', true],
    ['Eng. Nikola Tesla', 'tesla@demo.edu', 'faculty', eeeDeptId, northCampusId, null, '', 'Monday,Wednesday,Friday', true],
    ['Dr. Okeke', 'okeke@demo.edu', 'faculty', busDeptId, mainCampusId, null, '', 'Monday,Wednesday,Friday', true],
    ['Dr. Grace Hopper', 'hopper@demo.edu', 'faculty', itDeptId, techCampusId, null, '', 'Monday,Tuesday,Thursday,Friday', true],

    // Administrators
    ['Department Administrator', 'department.admin@demo.edu', 'department-admin', csDeptId, mainCampusId, null, '', '', true],
    ['Academic Administrator', 'academic.admin@demo.edu', 'academic-admin', null, mainCampusId, null, '', '', true],
    ['System Administrator', 'super.admin@demo.edu', 'super-admin', null, mainCampusId, null, '', '', true],
  ]

  const users = {}
  for (const [name, email, role, departmentId, campusId, programId, cohort, availabilityDays, available] of userSeeds) {
    const userDoc = {
      name, email, passwordHash, role, departmentId, campusId,
      programId: programId || null,
      cohort: cohort || '',
      availabilityDays: availabilityDays || '',
      available: available !== undefined ? available : true,
      status: 'Active',
    }
    if (role === 'faculty') {
      userDoc.facultyCode = `FAC-${String(Object.keys(users).length + 1).padStart(4, '0')}`
      userDoc.designation = 'Senior Lecturer'
      userDoc.maxTeachingHours = 20
    }
    const userId = await insert('users', userDoc)
    users[email] = userId
  }

  console.log('Seeding Rooms...')
  const roomSeeds = [
    ['Room A201', 'A201', mainCampusId, 60, 'Classroom'],
    ['Computing Lab 1', 'CL-101', mainCampusId, 36, 'Laboratory'],
    ['Computing Lab 2', 'CL-102', mainCampusId, 34, 'Laboratory'],
    ['AI & Robotics Lab', 'CL-103', techCampusId, 40, 'Laboratory'],
    ['Lecture Hall A', 'LH-A01', mainCampusId, 180, 'Lecture hall'],
    ['Lecture Hall B', 'LH-B01', mainCampusId, 140, 'Lecture hall'],
    ['Design Studio', 'DS-201', northCampusId, 28, 'Studio'],
    ['Room C104', 'C104', northCampusId, 44, 'Classroom'],
    ['Seminar Room 2', 'SR-202', northCampusId, 42, 'Meeting room'],
    ['Room B106', 'B106', northCampusId, 48, 'Classroom'],
    ['Innovation Hub', 'IH-001', mainCampusId, 32, 'Studio'],
    ['Engineering Lab', 'EL-001', northCampusId, 40, 'Laboratory'],
  ]

  const rooms = {}
  for (const [name, code, campusId, capacity, type] of roomSeeds) {
    rooms[name] = await insert('rooms', { name, code, campusId, capacity, type, status: 'Active' })
  }

  console.log('Seeding Working Days & Time Slots...')
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  for (const [index, day] of days.entries()) {
    await db.collection('working_days').insertOne({ day, enabled: index < 5, order: index })
  }

  const slotSeeds = [
    ['08:30', '09:45', 'CLASS'],
    ['10:00', '11:15', 'CLASS'],
    ['11:30', '12:30', 'BREAK'],
    ['13:00', '14:15', 'CLASS'],
    ['14:30', '15:45', 'CLASS'],
  ]
  for (const [start, end, type] of slotSeeds) {
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      await insert('time_slots', { day, start, end, type, sequence: slotSeeds.findIndex(s => s[0] === start) + 1, status: 'Active' })
    }
  }

  console.log('Seeding Timetable Schedules...')
  const scheduleSeeds = [
    [csDeptId, csProgId, 'Monday', '08:30', '09:45', 'Discrete Mathematics', 'MTH 204', users['faculty@demo.edu'], rooms['Room A201'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Monday', '10:00', '11:15', 'Data Structures & Algorithms', 'CSC 201', users['turing@demo.edu'], rooms['Computing Lab 1'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Monday', '13:00', '14:15', 'Programming II', 'CSC 220', users['faculty@demo.edu'], rooms['Computing Lab 1'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Tuesday', '09:00', '10:15', 'Database Systems', 'CSC 310', users['bello@demo.edu'], rooms['Lecture Hall B'], 'Year 3 · Group B', 'Published'],
    [csDeptId, csProgId, 'Tuesday', '13:00', '14:30', 'Interface Design', 'DES 215', users['lovelace@demo.edu'], rooms['Design Studio'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Wednesday', '09:30', '10:45', 'Algorithms & Complexity', 'CSC 305', users['turing@demo.edu'], rooms['Room C104'], 'Year 3 · Group B', 'Published'],
    [csDeptId, csProgId, 'Wednesday', '13:00', '14:30', 'Research Methods', 'RES 201', users['bello@demo.edu'], rooms['Seminar Room 2'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Thursday', '10:00', '11:15', 'Operating Systems', 'CSC 315', users['bello@demo.edu'], rooms['Lecture Hall A'], 'Year 3 · Group B', 'Published'],
    [csDeptId, csProgId, 'Thursday', '13:30', '15:00', 'Web Technologies & Cloud', 'CSC 230', users['lovelace@demo.edu'], rooms['Computing Lab 2'], 'Year 2 · Group A', 'Published'],
    [csDeptId, csProgId, 'Friday', '09:00', '10:30', 'Networks & Security', 'CSC 320', users['faculty@demo.edu'], rooms['Room B106'], 'Year 3 · Group B', 'Published'],
    [csDeptId, csProgId, 'Friday', '13:00', '14:30', 'AI & Machine Learning', 'CSC 401', users['turing@demo.edu'], rooms['AI & Robotics Lab'], 'Year 4 · Group A', 'Published'],
    [eeeDeptId, eeProgId, 'Monday', '08:30', '09:45', 'Circuit Analysis', 'EEE 201', users['adeyemi@demo.edu'], rooms['Engineering Lab'], 'Year 2 · Group A', 'Awaiting approval'],
    [eeeDeptId, eeProgId, 'Tuesday', '11:00', '12:15', 'Digital Signal Processing', 'EEE 304', users['nwosu@demo.edu'], rooms['Engineering Lab'], 'Year 3 · Group B', 'Draft'],
    [busDeptId, mbaProgId, 'Wednesday', '09:30', '10:45', 'Strategic Management', 'BUS 501', users['okeke@demo.edu'], rooms['Room C104'], 'Year 1 · Group A', 'Awaiting approval'],
  ]

  for (const [departmentId, programId, day, start, end, subject, code, facultyId, roomId, cohort, status] of scheduleSeeds) {
    await insert('schedules', { departmentId, programId, day, start, end, subject, code, facultyId, roomId, cohort, status, createdBy: null })
  }

  console.log('Seeding Conflicts...')
  const conflictSeeds = [
    ['Room overlap', 'Monday', '08:30', '09:45', 'Room A201 is assigned to two classes simultaneously.', 'Discrete Mathematics · Circuit Analysis', csDeptId, true],
    ['Faculty availability', 'Tuesday', '09:00', '10:15', 'Faculty member Dr. Bello is marked unavailable during this period.', 'Database Systems · Dr. Bello', csDeptId, false],
  ]
  for (const [type, day, start, end, detail, scheduleNames, departmentId, isCrossDepartment] of conflictSeeds) {
    await insert('conflicts', { type, day, start, end, detail, schedules: scheduleNames, departmentId, isCrossDepartment, status: 'Open' })
  }

  console.log('Seeding System Settings & Audit Logs...')
  const settings = {
    institutionName: 'Timetable Allocation & Management Portal',
    academicYear: '2026/2027',
    semester: 'First Semester',
    timeZone: 'Asia/Kolkata',
    conflictDetection: 'true',
    userRegistration: 'false',
    auditRetention: '365',
  }
  for (const [key, value] of Object.entries(settings)) {
    await db.collection('system_settings').insertOne({ key, value })
  }

  await insert('audit_logs', { actorId: null, actorName: 'Academic Administrator', action: 'Published timetable', target: 'Computer Science', details: 'First Semester 2026/2027 timetable published successfully.' })
  await insert('audit_logs', { actorId: null, actorName: 'System', action: 'Seed execution', target: 'Database', details: 'Seeded fresh demo data for campuses, departments, users, programs, rooms, and schedules.' })

  console.log('Database seeding completed successfully!')
  await client.close()
}

seed().catch((err) => {
  console.error('Seeding failed:', err)
  process.exit(1)
})
