import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.SEED_PASSWORD = 'test-password-2026'
process.env.AUTH_TOKEN_SECRET = 'integration-test-secret'

const [{ createApp }, { MongoMemoryServer }, { MongoClient }, { initializeDatabase, nextId }, { validateTimetableEntry }] = await Promise.all([
  import('../src/app.js'),
  import('mongodb-memory-server'),
  import('mongodb'),
  import('../src/config/database.js'),
  import('../src/utils/timetableConflictService.js'),
])

const memoryServer = await MongoMemoryServer.create()
const client = new MongoClient(memoryServer.getUri())
await client.connect()
const database = client.db('timetable_test')
await initializeDatabase(database)
const app = createApp({ database, tokenSecret: process.env.AUTH_TOKEN_SECRET })
let server
let baseUrl

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await client.close()
  await memoryServer.stop()
})

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, data: await response.json() }
}

async function signIn(email) {
  const { response, data } = await request('/auth/login', {
    method: 'POST',
    body: { email, password: process.env.SEED_PASSWORD },
  })
  assert.equal(response.status, 200)
  return data
}

test('authenticates seeded roles and blocks invalid credentials', async () => {
  const login = await signIn('student@demo.edu')
  assert.equal(login.user.role, 'student')
  assert.ok(login.token)

  const invalid = await request('/auth/login', {
    method: 'POST',
    body: { email: 'student@demo.edu', password: 'incorrect' },
  })
  assert.equal(invalid.response.status, 401)

  const malformedToken = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: 'Bearer' } })
  assert.equal(malformedToken.status, 401)
})

test('serves a student timetable and enforces role access', async () => {
  const student = await signIn('student@demo.edu')
  const timetable = await request('/dashboard/timetable', { token: student.token })
  assert.equal(timetable.response.status, 200)
  assert.equal(timetable.data.week.length, 7)
  assert.equal(timetable.data.summary.weekCount, 6)

  const denied = await request('/system/overview', { token: student.token })
  assert.equal(denied.response.status, 403)
})

test('limits a faculty timetable to classes assigned to that faculty member', async () => {
  const faculty = await signIn('faculty@demo.edu')
  const timetable = await request('/dashboard/timetable', { token: faculty.token })
  const assignedSchedules = await database.collection('schedules').find({
    facultyId: faculty.user.id,
    status: 'Published',
  }).toArray()
  const visibleScheduleIds = timetable.data.week.flatMap((day) => day.classes.map((item) => item.id)).sort()
  const assignedScheduleIds = assignedSchedules.map((item) => item.id).sort()

  assert.equal(timetable.response.status, 200)
  assert.deepEqual(visibleScheduleIds, assignedScheduleIds)
})

test('calculates faculty workload from published timetable entries', async () => {
  const facultyLogin = await signIn('faculty@demo.edu')
  const facultyRecord = await database.collection('users').findOne({ email: facultyLogin.user.email })
  const workload = await request('/dashboard/workload', { token: facultyLogin.token })
  assert.equal(workload.response.status, 200)
  assert.equal(workload.data.weeklyTeachingHours, 8.5)
  assert.equal(workload.data.dailyTeachingHours.find((day) => day.day === 'Monday').hours, 2.75)
  assert.equal(workload.data.numberOfClasses, 6)
  assert.equal(workload.data.maximumAllowedHours, 20)
  assert.equal(workload.data.utilizationPercentage, 42.5)
  assert.equal(workload.data.workloadStatus, 'Under-utilized')

  const departmentAdmin = await signIn('department.admin@demo.edu')
  const report = await request('/admin/faculty-workload', { token: departmentAdmin.token })
  assert.equal(report.response.status, 200)
  assert.ok(report.data.faculty.some((item) => item.facultyId === facultyRecord.id))
  assert.equal(report.data.summary.facultyCount, report.data.faculty.length)

  await database.collection('users').updateOne({ id: facultyRecord.id }, { $set: { maxTeachingHours: 8 } })
  const overloaded = await request(`/admin/faculty/${facultyRecord.id}/workload`, { token: departmentAdmin.token })
  assert.equal(overloaded.data.workloadStatus, 'Overloaded')
  const overloadedList = await request('/admin/faculty-workload', { token: departmentAdmin.token })
  assert.ok(overloadedList.data.overloadedFaculty.some((item) => item.facultyId === facultyRecord.id))
  await database.collection('users').updateOne({ id: facultyRecord.id }, { $set: { maxTeachingHours: 20 } })
})

test('manages faculty profiles, assignments, availability, search, and workload', async () => {
  const superAdmin = await signIn('super.admin@demo.edu')
  const seededFaculty = await database.collection('users').findOne({ email: 'faculty@demo.edu' })
  assert.match(seededFaculty.facultyCode, /^FAC-\d{4}$/)
  assert.ok(seededFaculty.availableSlots.some((slot) => slot.day === 'Monday'))
  assert.equal(seededFaculty.maxTeachingHours, 20)
  const department = await database.collection('departments').findOne({ name: 'Computer Science' })
  const program = await database.collection('programs').findOne({ departmentId: department.id, status: 'Active' })
  const academicYear = await database.collection('academic_years').findOne({ status: 'Active' })
  const batchId = await nextId(database, 'batches')
  const semesterId = await nextId(database, 'semesters')
  const sectionId = await nextId(database, 'sections')
  const subjectId = await nextId(database, 'subjects')
  await database.collection('batches').insertOne({ id: batchId, name: 'Faculty Test Batch', academicYearId: academicYear.id, departmentId: department.id, programId: program.id, status: 'Active' })
  await database.collection('semesters').insertOne({ id: semesterId, name: 'Faculty Test Semester', batchId, status: 'Active' })
  await database.collection('sections').insertOne({ id: sectionId, name: 'Faculty Test Section', code: 'FT', semesterId, status: 'Active' })
  await database.collection('subjects').insertOne({ id: subjectId, code: 'FAC 101', name: 'Faculty Test Subject', departmentId: department.id, status: 'Active', facultyId: null })
  const subject = { id: subjectId }
  const section = { id: sectionId }
  const profile = {
    facultyCode: 'FAC-TEST-01', name: 'Taylor Faculty', email: 'taylor.faculty@demo.edu',
    password: 'faculty-test-password', departmentId: department.id, designation: 'Senior Lecturer',
    subjectIds: [subject.id], sectionIds: [section.id], maxTeachingHours: 18,
    availableSlots: [{ day: 'Monday', start: '08:00', end: '10:00' }],
    unavailableSlots: [{ day: 'Tuesday', start: '12:00', end: '14:00' }],
    preferredSlots: [{ day: 'Monday', start: '08:30', end: '09:30' }],
  }
  const created = await request('/system/faculty', { method: 'POST', token: superAdmin.token, body: profile })
  assert.equal(created.response.status, 201, JSON.stringify(created.data))
  assert.equal(created.data.record.facultyCode, profile.facultyCode)
  assert.equal(created.data.record.subjects.length, 1)
  assert.equal(created.data.record.sections.length, 1)
  assert.deepEqual(created.data.record.availableSlots, profile.availableSlots)
  assert.deepEqual(created.data.record.unavailableSlots, profile.unavailableSlots)
  assert.deepEqual(created.data.record.preferredSlots, profile.preferredSlots)

  const filtered = await request(`/system/faculty?search=${encodeURIComponent('Taylor')}&departmentId=${department.id}`, { token: superAdmin.token })
  assert.equal(filtered.response.status, 200)
  assert.deepEqual(filtered.data.records.map((item) => item.id), [created.data.record.id])
  assert.ok(filtered.data.options.timeSlots.length)
  const activeFaculty = await request('/system/faculty?status=Active', { token: superAdmin.token })
  assert.ok(activeFaculty.data.records.some((item) => item.id === created.data.record.id))
  const inactiveFaculty = await request('/system/faculty?status=Inactive', { token: superAdmin.token })
  assert.ok(!inactiveFaculty.data.records.some((item) => item.id === created.data.record.id))

  const details = await request(`/system/faculty/${created.data.record.id}`, { token: superAdmin.token })
  assert.equal(details.data.record.maxTeachingHours, 18)
  const updated = await request(`/system/faculty/${created.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { ...profile, password: '', maxTeachingHours: 22, subjectIds: [], preferredSlots: [] },
  })
  assert.equal(updated.data.record.maxTeachingHours, 22)
  assert.deepEqual(updated.data.record.subjectIds, [])

  const invalidSlots = await request('/system/faculty', {
    method: 'POST', token: superAdmin.token,
    body: { ...profile, facultyCode: 'FAC-BAD', email: 'faculty.bad@demo.edu', availableSlots: [{ day: 'Funday', start: '09:00', end: '10:00' }] },
  })
  assert.equal(invalidSlots.response.status, 400)

  const protectedDelete = await request(`/system/faculty/${seededFaculty.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(protectedDelete.response.status, 409)

  const removed = await request(`/system/faculty/${created.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(removed.response.status, 200)
  assert.equal(removed.data.deleted, true)
})

test('allows faculty to request a class change and admins to review it', async () => {
  const faculty = await signIn('faculty@demo.edu')
  const assignedSchedule = await database.collection('schedules').findOne({
    facultyId: faculty.user.id,
    status: 'Published',
  })
  const anotherFacultySchedule = await database.collection('schedules').findOne({
    facultyId: { $ne: faculty.user.id },
    status: 'Published',
  })
  const deniedRequest = await request('/dashboard/change-requests', {
    method: 'POST',
    token: faculty.token,
    body: { scheduleId: anotherFacultySchedule.id, proposedChange: 'Move time', reason: 'Availability' },
  })
  assert.equal(deniedRequest.response.status, 404)

  const submitted = await request('/dashboard/change-requests', {
    method: 'POST',
    token: faculty.token,
    body: { scheduleId: assignedSchedule.id, proposedChange: 'Move to 10:00', reason: 'Lab availability' },
  })
  assert.equal(submitted.response.status, 201)
  assert.equal(submitted.data.status, 'Pending')

  const ownRequests = await request('/dashboard/change-requests', { token: faculty.token })
  assert.ok(ownRequests.data.some((item) => item.id === submitted.data.id))

  const student = await signIn('student@demo.edu')
  const denied = await request('/dashboard/change-requests', { method: 'POST', token: student.token, body: {} })
  assert.equal(denied.response.status, 403)

  const departmentAdmin = await signIn('department.admin@demo.edu')
  const adminRequests = await request('/admin/change-requests', { token: departmentAdmin.token })
  assert.ok(adminRequests.data.some((item) => item.id === submitted.data.id))
  const reviewed = await request(`/admin/change-requests/${submitted.data.id}`, {
    method: 'PATCH', token: departmentAdmin.token, body: { status: 'Approved' },
  })
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.data.status, 'Approved')
})

test('allows faculty to request leave and view their own requests', async () => {
  const faculty = await signIn('faculty@demo.edu')
  const submitted = await request('/dashboard/leave-requests', {
    method: 'POST',
    token: faculty.token,
    body: { leaveType: 'Casual Leave', startDate: '2026-04-06', endDate: '2026-04-08', reason: 'Family function' },
  })
  assert.equal(submitted.response.status, 201)
  assert.equal(submitted.data.status, 'Pending')
  assert.equal(submitted.data.numberOfDays, 3)

  const invalidType = await request('/dashboard/leave-requests', {
    method: 'POST',
    token: faculty.token,
    body: { leaveType: 'Vacation', startDate: '2026-04-06', endDate: '2026-04-08', reason: 'Not a valid type' },
  })
  assert.equal(invalidType.response.status, 400)

  const invalidRange = await request('/dashboard/leave-requests', {
    method: 'POST',
    token: faculty.token,
    body: { leaveType: 'Sick Leave', startDate: '2026-04-08', endDate: '2026-04-06', reason: 'Reversed dates' },
  })
  assert.equal(invalidRange.response.status, 400)

  const ownRequests = await request('/dashboard/leave-requests', { token: faculty.token })
  assert.ok(ownRequests.data.some((item) => item.id === submitted.data.id))

  const student = await signIn('student@demo.edu')
  const denied = await request('/dashboard/leave-requests', { method: 'POST', token: student.token, body: {} })
  assert.equal(denied.response.status, 403)
})

test('lets admins review faculty leave requests in their department', async () => {
  const faculty = await signIn('faculty@demo.edu')
  const submitted = await request('/dashboard/leave-requests', {
    method: 'POST',
    token: faculty.token,
    body: { leaveType: 'Sick Leave', startDate: '2026-05-04', endDate: '2026-05-05', reason: 'Medical review' },
  })
  assert.equal(submitted.response.status, 201)

  const student = await signIn('student@demo.edu')
  const denied = await request('/admin/leave-requests', { token: student.token })
  assert.equal(denied.response.status, 403)

  const departmentAdmin = await signIn('department.admin@demo.edu')
  const adminRequests = await request('/admin/leave-requests', { token: departmentAdmin.token })
  assert.ok(adminRequests.data.some((item) => item.id === submitted.data.id))

  const reviewed = await request(`/admin/leave-requests/${submitted.data.id}`, {
    method: 'PATCH', token: departmentAdmin.token, body: { status: 'Approved' },
  })
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.data.status, 'Approved')
  assert.equal(reviewed.data.reviewedBy, 'Department Administrator')

  const repeated = await request(`/admin/leave-requests/${submitted.data.id}`, {
    method: 'PATCH', token: departmentAdmin.token, body: { status: 'Declined' },
  })
  assert.equal(repeated.response.status, 409)
})

test('creates a conflict-free schedule and enforces approval transitions', async () => {
  const student = await signIn('student@demo.edu')
  const departmentAdmin = await signIn('department.admin@demo.edu')
  const bootstrap = await request('/admin/bootstrap', { token: departmentAdmin.token })
  const faculty = bootstrap.data.faculty.find((item) => item.name === 'Dr. Mensah')
  const room = await database.collection('rooms').findOne({ name: 'Room A201' })
  const created = await request('/admin/schedules', {
    method: 'POST',
    token: departmentAdmin.token,
    body: { day: 'Friday', start: '16:00', end: '17:00', subject: 'Integration Test', code: 'CSC 999', facultyId: faculty.id, roomId: room.id, group: 'Year 2 · Group A' },
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.data.conflictsCreated, 0)
  const scheduleCount = await database.collection('schedules').countDocuments()
  const rejected = await request('/admin/schedules', {
    method: 'POST', token: departmentAdmin.token,
    body: { day: 'Friday', start: '16:00', end: '17:00', subject: 'Duplicate Integration Test', code: 'CSC 998', facultyId: faculty.id, roomId: room.id, group: 'Year 2 · Group A' },
  })
  assert.equal(rejected.response.status, 409)
  assert.equal(rejected.data.type, 'FACULTY_CONFLICT')
  assert.equal(rejected.data.conflict, true)
  assert.equal(await database.collection('schedules').countDocuments(), scheduleCount)

  const submitted = await request('/admin/schedules/status', {
    method: 'PATCH',
    token: departmentAdmin.token,
    body: { ids: [created.data.id], status: 'Awaiting approval' },
  })
  assert.equal(submitted.response.status, 200)
  const submittedRecord = await database.collection('schedules').findOne({ id: created.data.id })
  assert.equal(submittedRecord.submittedBy, departmentAdmin.user.id)
  assert.ok(submittedRecord.submittedAt instanceof Date)

  const forbiddenReview = await request('/admin/schedules/status', {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ids: [created.data.id], status: 'Under review' },
  })
  assert.equal(forbiddenReview.response.status, 403)

  const academicAdmin = await signIn('academic.admin@demo.edu')
  const reviewed = await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [created.data.id], status: 'Under review', reviewComments: 'Checking resource allocation.' },
  })
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.data.status, 'Under review')
  const reviewedRecord = await database.collection('schedules').findOne({ id: created.data.id })
  assert.equal(reviewedRecord.reviewedBy, academicAdmin.user.id)
  assert.ok(reviewedRecord.reviewedAt instanceof Date)
  assert.equal(reviewedRecord.reviewComments, 'Checking resource allocation.')

  const approved = await request('/admin/schedules/status', {
    method: 'PATCH',
    token: academicAdmin.token,
    body: { ids: [created.data.id], status: 'Approved' },
  })
  assert.equal(approved.response.status, 200)
  const approvedRecord = await database.collection('schedules').findOne({ id: created.data.id })
  assert.equal(approvedRecord.approvedBy, academicAdmin.user.id)
  assert.ok(approvedRecord.approvedAt instanceof Date)

  const forbiddenAcademicPublish = await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [created.data.id], status: 'Published' },
  })
  assert.equal(forbiddenAcademicPublish.response.status, 403)

  const published = await request('/admin/schedules/status', {
    method: 'PATCH',
    token: departmentAdmin.token,
    body: { ids: [created.data.id], status: 'Published' },
  })
  assert.equal(published.response.status, 200)

  const notifications = await request('/dashboard/notifications', { token: student.token })
  assert.equal(notifications.response.status, 200)
  assert.ok(notifications.data.notifications.some((item) => item.title.includes('Integration Test')))

  const rejectedDraft = await request('/admin/schedules', {
    method: 'POST', token: departmentAdmin.token,
    body: { day: 'Friday', start: '17:00', end: '18:00', subject: 'Rejected Transition Test', code: 'CSC 997', facultyId: faculty.id, roomId: room.id, group: 'Transition Group R' },
  })
  assert.equal(rejectedDraft.response.status, 201)
  await request('/admin/schedules/status', {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ids: [rejectedDraft.data.id], status: 'Awaiting approval' },
  })
  await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [rejectedDraft.data.id], status: 'Under review' },
  })
  const missingReason = await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [rejectedDraft.data.id], status: 'Rejected' },
  })
  assert.equal(missingReason.response.status, 400)
  const rejectionResult = await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [rejectedDraft.data.id], status: 'Rejected', rejectionReason: 'Faculty assignment needs correction.' },
  })
  assert.equal(rejectionResult.data.status, 'Rejected')
  const rejectedRecord = await database.collection('schedules').findOne({ id: rejectedDraft.data.id })
  assert.equal(rejectedRecord.reviewedBy, academicAdmin.user.id)
  assert.equal(rejectedRecord.rejectionReason, 'Faculty assignment needs correction.')
  assert.ok(rejectedRecord.reviewedAt instanceof Date)

  const returnedDraft = await request('/admin/schedules', {
    method: 'POST', token: departmentAdmin.token,
    body: { day: 'Friday', start: '18:00', end: '19:00', subject: 'Returned Transition Test', code: 'CSC 996', facultyId: faculty.id, roomId: room.id, group: 'Transition Group C' },
  })
  assert.equal(returnedDraft.response.status, 201)
  await request('/admin/schedules/status', {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ids: [returnedDraft.data.id], status: 'Awaiting approval' },
  })
  await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [returnedDraft.data.id], status: 'Under review' },
  })
  const returned = await request('/admin/schedules/status', {
    method: 'PATCH', token: academicAdmin.token,
    body: { ids: [returnedDraft.data.id], status: 'Returned for changes', reviewComments: 'Choose another teaching period.' },
  })
  assert.equal(returned.data.status, 'Returned for changes')
  const returnedRecord = await database.collection('schedules').findOne({ id: returnedDraft.data.id })
  assert.equal(returnedRecord.reviewComments, 'Choose another teaching period.')
  assert.equal(returnedRecord.reviewedBy, academicAdmin.user.id)
  const resubmitted = await request('/admin/schedules/status', {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ids: [returnedDraft.data.id], status: 'Awaiting approval' },
  })
  assert.equal(resubmitted.data.status, 'Awaiting approval')
  const resubmittedRecord = await database.collection('schedules').findOne({ id: returnedDraft.data.id })
  assert.equal(resubmittedRecord.submittedBy, departmentAdmin.user.id)
  assert.ok(resubmittedRecord.submittedAt instanceof Date)
  assert.equal(resubmittedRecord.reviewedBy, academicAdmin.user.id)

  const crossDepartmentConflict = await request('/admin/conflicts/1/resolve', {
    method: 'PATCH',
    token: departmentAdmin.token,
  })
  assert.equal(crossDepartmentConflict.response.status, 403)
})

test('auto-fixes clashing classes when an admin resolves a conflict', async () => {
  const departmentAdmin = await signIn('department.admin@demo.edu')
  const department = await database.collection('departments').findOne({ name: 'Computer Science' })
  const program = await database.collection('programs').findOne({ departmentId: department.id, status: 'Active' })
  const [facultyA, facultyB, room] = await Promise.all([
    database.collection('users').findOne({ email: 'faculty@demo.edu' }),
    database.collection('users').findOne({ email: 'bello@demo.edu' }),
    database.collection('rooms').findOne({ code: 'CL-101' }),
  ])
  const scheduleIds = []
  const fixtures = [
    { subject: 'AutoFix Lecture', code: 'AF101', facultyId: facultyA.id, cohort: 'AutoFix Group A' },
    { subject: 'AutoFix Lab', code: 'AF102', facultyId: facultyB.id, cohort: 'AutoFix Group B' },
  ]
  for (const fixture of fixtures) {
    const id = await nextId(database, 'schedules')
    scheduleIds.push(id)
    await database.collection('schedules').insertOne({
      id, departmentId: department.id, programId: program.id, day: 'Friday', start: '15:00', end: '16:00',
      subject: fixture.subject, code: fixture.code, facultyId: fixture.facultyId, roomId: room.id,
      cohort: fixture.cohort, status: 'Draft', createdBy: null,
    })
  }
  const conflictId = await nextId(database, 'conflicts')
  await database.collection('conflicts').insertOne({
    id: conflictId, type: 'Room overlap', day: 'Friday', start: '15:00', end: '16:00',
    detail: `${room.name} is assigned to two classes simultaneously.`,
    schedules: 'AutoFix Lecture · AutoFix Lab', departmentId: department.id, isCrossDepartment: false, status: 'Open',
  })

  const resolved = await request(`/admin/conflicts/${conflictId}/resolve`, {
    method: 'PATCH', token: departmentAdmin.token,
  })
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.data))
  assert.equal(resolved.data.status, 'Resolved')
  assert.equal(resolved.data.autoFixed, true)
  assert.ok(resolved.data.message.length > 0)

  const conflict = await database.collection('conflicts').findOne({ id: conflictId })
  assert.equal(conflict.status, 'Resolved')
  assert.equal(conflict.resolutionAction, 'room')
  const updated = await database.collection('schedules').find({ id: { $in: scheduleIds } }).toArray()
  const changed = updated.filter((item) => item.roomId !== room.id || item.day !== 'Friday' || item.start !== '15:00' || item.facultyId !== fixtures.find((f) => f.subject === item.subject).facultyId)
  assert.equal(changed.length, 1, `expected exactly one schedule to change: ${JSON.stringify(updated)}`)
  const remainingClash = await database.collection('schedules').countDocuments({
    day: 'Friday', roomId: room.id, start: { $lt: '16:00' }, end: { $gt: '15:00' },
  })
  assert.equal(remainingClash, 1, 'the original room must no longer hold two classes')
  const validation = await validateTimetableEntry(database, changed[0], { excludeEntryId: changed[0].id })
  assert.equal(validation.conflict, false, JSON.stringify(validation.conflicts))

  await database.collection('schedules').deleteMany({ id: { $in: scheduleIds } })
  await database.collection('conflicts').deleteOne({ id: conflictId })
})

test('rejects overlapping time slots without changing the saved calendar', async () => {
  const academicAdmin = await signIn('academic.admin@demo.edu')
  const before = await request('/admin/calendar', { token: academicAdmin.token })
  const overlapping = await request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: {
      workingDays: ['Monday', 'Tuesday'],
      timeSlots: [
        { day: 'Monday', start: '08:00', end: '10:00', type: 'CLASS', sequence: 1, status: 'Active' },
        { day: 'Monday', start: '09:30', end: '10:30', type: 'BREAK', sequence: 2, status: 'Active' },
      ],
    },
  })
  assert.equal(overlapping.response.status, 400)
  const after = await request('/admin/calendar', { token: academicAdmin.token })
  assert.deepEqual(after.data, before.data)
})

test('configures working days and ordered class, break, and lunch slots', async () => {
  const academicAdmin = await signIn('academic.admin@demo.edu')
  const initial = await request('/admin/calendar', { token: academicAdmin.token })
  assert.ok(initial.data.timeSlots.every((slot) => slot.day && slot.type === 'CLASS' && slot.sequence && slot.status === 'Active'))
  assert.equal(new Set(initial.data.timeSlots.map((slot) => slot.id)).size, initial.data.timeSlots.length)
  const calendar = {
    workingDays: ['Wednesday', 'Monday', 'Tuesday'],
    timeSlots: [
      { day: 'Monday', start: '08:00', end: '09:00', type: 'CLASS', sequence: 1, status: 'Active' },
      { day: 'Monday', start: '09:00', end: '09:15', type: 'BREAK', sequence: 2, status: 'Active' },
      { day: 'Monday', start: '09:15', end: '12:00', type: 'CLASS', sequence: 3, status: 'Active' },
      { day: 'Monday', start: '12:00', end: '13:00', type: 'LUNCH', sequence: 4, status: 'Inactive' },
      { day: 'Tuesday', start: '08:00', end: '09:00', type: 'CLASS', sequence: 1, status: 'Active' },
      { day: 'Wednesday', start: '08:30', end: '09:30', type: 'CLASS', sequence: 1, status: 'Active' },
    ],
  }
  const saved = await request('/admin/calendar', { method: 'PUT', token: academicAdmin.token, body: calendar })
  assert.equal(saved.response.status, 200)
  assert.deepEqual(saved.data.workingDays, ['Monday', 'Tuesday', 'Wednesday'])
  assert.deepEqual(saved.data.timeSlots.map(({ day, sequence }) => [day, sequence]), [
    ['Monday', 1], ['Monday', 2], ['Monday', 3], ['Monday', 4], ['Tuesday', 1], ['Wednesday', 1],
  ])
  assert.deepEqual(saved.data.timeSlots.map((slot) => slot.type), ['CLASS', 'BREAK', 'CLASS', 'LUNCH', 'CLASS', 'CLASS'])
  assert.equal(saved.data.timeSlots[3].status, 'Inactive')

  const retrieved = await request('/admin/calendar', { token: academicAdmin.token })
  assert.deepEqual(retrieved.data, saved.data)
  const malformed = await request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: { ...calendar, timeSlots: [{ ...calendar.timeSlots[0], start: '8:00' }] },
  })
  assert.equal(malformed.response.status, 400)
  const invalidType = await request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: { ...calendar, timeSlots: [{ ...calendar.timeSlots[0], type: 'STUDY' }] },
  })
  assert.equal(invalidType.response.status, 400)
  const incorrectOrder = await request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: {
      ...calendar,
      timeSlots: calendar.timeSlots.slice(0, 2).map((slot, index) => ({
        ...slot, sequence: index === 0 ? 2 : 1,
      })),
    },
  })
  assert.equal(incorrectOrder.response.status, 400)
  const duplicateSequence = await request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: { ...calendar, timeSlots: calendar.timeSlots.slice(0, 2).map((slot) => ({ ...slot, sequence: 1 })) },
  })
  assert.equal(duplicateSequence.response.status, 400)

  const departmentAdmin = await signIn('department.admin@demo.edu')
  const denied = await request('/admin/calendar', { method: 'PUT', token: departmentAdmin.token, body: calendar })
  assert.equal(denied.response.status, 403)
})

test('keeps existing time slot ids stable when the calendar is saved', async () => {
  const academicAdmin = await signIn('academic.admin@demo.edu')
  const original = await request('/admin/calendar', { token: academicAdmin.token })
  assert.ok(original.data.timeSlots.length > 0)
  const save = (timeSlots) => request('/admin/calendar', {
    method: 'PUT', token: academicAdmin.token,
    body: { workingDays: original.data.workingDays, timeSlots },
  })

  // Editing a saved slot keeps its id and persists the change.
  const edited = original.data.timeSlots.map((slot, index) => index === 0 ? { ...slot, status: 'Inactive' } : slot)
  const editedSave = await save(edited)
  assert.equal(editedSave.response.status, 200)
  assert.deepEqual(editedSave.data.timeSlots.map((slot) => slot.id), original.data.timeSlots.map((slot) => slot.id))
  assert.equal(editedSave.data.timeSlots[0].status, 'Inactive')

  // Slots without an id are inserted as new records; existing ids never move.
  const withNew = [...edited, { day: 'Wednesday', start: '09:30', end: '10:30', type: 'CLASS', sequence: 2, status: 'Active' }]
  const inserted = await save(withNew)
  assert.equal(inserted.response.status, 200)
  assert.equal(inserted.data.timeSlots.length, original.data.timeSlots.length + 1)
  assert.deepEqual(inserted.data.timeSlots.slice(0, -1).map((slot) => slot.id), original.data.timeSlots.map((slot) => slot.id))
  assert.ok(!original.data.timeSlots.some((slot) => slot.id === inserted.data.timeSlots.at(-1).id))

  // Restoring the original payload removes the added slot and keeps every id.
  const restored = await save(original.data.timeSlots)
  assert.equal(restored.response.status, 200)
  assert.deepEqual(restored.data, original.data)
})

test('creates, edits, moves, and deletes manual timetable entries', async () => {
  const departmentAdmin = await signIn('department.admin@demo.edu')
  const department = await database.collection('departments').findOne({ name: 'Computer Science' })
  const academicYear = await database.collection('academic_years').findOne({ status: 'Active' })
  const program = await database.collection('programs').findOne({ departmentId: department.id, status: 'Active' })
  const batchId = await nextId(database, 'batches')
  const semesterId = await nextId(database, 'semesters')
  const sectionId = await nextId(database, 'sections')
  const alternateSectionId = await nextId(database, 'sections')
  const subjectId = await nextId(database, 'subjects')
  const alternateSubjectId = await nextId(database, 'subjects')
  await database.collection('batches').insertOne({
    id: batchId, name: 'Manual Test Batch', code: 'MANUAL-TEST', academicYearId: academicYear.id,
    departmentId: department.id, programId: program.id, status: 'Active',
  })
  await database.collection('semesters').insertOne({ id: semesterId, name: 'Manual Test Semester', batchId, status: 'Active' })
  await database.collection('sections').insertOne({ id: sectionId, name: 'Manual Test Section', code: 'MT', semesterId, status: 'Active' })
  await database.collection('sections').insertOne({ id: alternateSectionId, name: 'Manual Test Section 2', code: 'M2', semesterId, status: 'Active' })
  await database.collection('subjects').insertMany([
    { id: subjectId, code: 'MAN 101', name: 'Manual Timetable Subject', academicYearId: academicYear.id, departmentId: department.id, programId: program.id, batchId, semesterId, weeklyHours: 1, theoryHours: 1, practicalHours: 0, requiresLab: false, status: 'Active' },
    { id: alternateSubjectId, code: 'MAN 102', name: 'Manual Lab Subject', academicYearId: academicYear.id, departmentId: department.id, programId: program.id, batchId, semesterId, weeklyHours: 0, theoryHours: 0, practicalHours: 0, requiresLab: true, status: 'Active' },
  ])
  const faculty = await database.collection('users').findOne({ email: 'faculty@demo.edu' })
  const alternateFaculty = await database.collection('users').findOne({ email: 'bello@demo.edu' })
  const room = await database.collection('rooms').findOne({ type: 'Classroom', campusId: department.campusId, status: 'Active' })
  const alternateRoom = await database.collection('rooms').findOne({ campusId: department.campusId, status: 'Active', id: { $ne: room.id } })
  const lab = await database.collection('rooms').findOne({ type: 'Laboratory', campusId: department.campusId, status: 'Active' })
  const tuesdaySlot = await database.collection('time_slots').findOne({ day: 'Tuesday', type: 'CLASS', status: 'Active' })
  const mondayLateSlotId = await nextId(database, 'time_slots')
  await database.collection('time_slots').insertOne({ id: mondayLateSlotId, day: 'Monday', start: '15:00', end: '16:00', type: 'CLASS', sequence: 5, status: 'Active' })
  const selection = { academicYearId: academicYear.id, departmentId: department.id, programId: program.id, batchId, semesterId, sectionId }

  const options = await request(`/admin/manual-timetable/options?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.equal(options.response.status, 200)
  assert.ok(options.data.subjects.some((item) => item.id === subjectId))
  assert.ok(options.data.faculty.some((item) => item.id === faculty.id))
  assert.ok(options.data.rooms.some((item) => item.id === room.id))
  assert.ok(options.data.labs.some((item) => item.id === lab.id))

  const breakSlotId = await nextId(database, 'time_slots')
  await database.collection('time_slots').insertOne({ id: breakSlotId, day: 'Monday', start: '10:00', end: '10:15', type: 'BREAK', sequence: 99, status: 'Active' })
  const rejectedBreak = await request('/admin/manual-timetable/entries', {
    method: 'POST', token: departmentAdmin.token,
    body: { ...selection, subjectId, facultyId: faculty.id, roomId: room.id, day: 'Monday', timeSlotId: breakSlotId, classType: 'LECTURE' },
  })
  assert.equal(rejectedBreak.response.status, 400)
  await database.collection('time_slots').deleteOne({ id: breakSlotId })

  const conflictsBefore = await database.collection('conflicts').countDocuments()
  const entryPayload = { ...selection, subjectId, facultyId: faculty.id, roomId: room.id, day: 'Monday', timeSlotId: mondayLateSlotId, classType: 'LECTURE' }
  const created = await request('/admin/manual-timetable/entries', {
    method: 'POST', token: departmentAdmin.token,
    body: entryPayload,
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.data.entry.subjectId, subjectId)
  assert.equal(created.data.entry.sectionId, sectionId)
  assert.equal(created.data.entry.status, 'Draft')
  const initialValidation = await request('/admin/manual-timetable/validate', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(initialValidation.response.status, 200)
  assert.equal(initialValidation.data.valid, true, JSON.stringify(initialValidation.data))

  await database.collection('schedules').updateOne({ id: created.data.entry.id }, { $set: { facultyId: null } })
  const incompleteValidation = await request('/admin/manual-timetable/validate', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(incompleteValidation.response.status, 200)
  assert.equal(incompleteValidation.data.valid, false)
  assert.ok(incompleteValidation.data.conflicts.some((item) => item.type === 'MISSING_REQUIRED_ASSIGNMENT'))
  const blockedSubmission = await request('/admin/schedules/status', {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ids: [created.data.entry.id], status: 'Awaiting approval' },
  })
  assert.equal(blockedSubmission.response.status, 409)
  assert.equal(blockedSubmission.data.valid, false)
  assert.equal((await database.collection('schedules').findOne({ id: created.data.entry.id })).status, 'Draft')
  await database.collection('schedules').updateOne({ id: created.data.entry.id }, { $set: { facultyId: faculty.id } })

  const invalidRelationship = await request('/admin/manual-timetable/validate', {
    method: 'POST', token: departmentAdmin.token, body: { ...selection, academicYearId: 999999 },
  })
  assert.equal(invalidRelationship.data.valid, false)
  assert.ok(invalidRelationship.data.conflicts.some((item) => item.type === 'INVALID_ACADEMIC_RELATIONSHIP'))

  await database.collection('subjects').updateOne({ id: subjectId }, { $set: { weeklyHours: 2, theoryHours: 2 } })
  const underScheduled = await request('/admin/manual-timetable/validate', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(underScheduled.data.valid, false)
  assert.ok(underScheduled.data.conflicts.some((item) => item.type === 'WEEKLY_SUBJECT_HOURS'))
  await database.collection('subjects').updateOne({ id: subjectId }, { $set: { weeklyHours: 1, theoryHours: 1 } })

  const facultyOverlap = await request('/admin/manual-timetable/entries', {
    method: 'POST', token: departmentAdmin.token,
    body: { ...entryPayload, sectionId: alternateSectionId, roomId: alternateRoom.id },
  })
  assert.equal(facultyOverlap.response.status, 409)
  assert.equal(facultyOverlap.data.type, 'FACULTY_CONFLICT')
  assert.equal(facultyOverlap.data.conflict, true)
  assert.ok(facultyOverlap.data.message)
  assert.ok(facultyOverlap.data.conflicts.some((item) => item.type === 'FACULTY_CONFLICT'))
  const occupiedCell = await request('/admin/manual-timetable/entries', {
    method: 'POST', token: departmentAdmin.token, body: entryPayload,
  })
  assert.equal(occupiedCell.response.status, 409)

  const listed = await request(`/admin/manual-timetable/entries?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.equal(listed.data.entries.length, 1)
  assert.equal(listed.data.entries[0].id, created.data.entry.id)

  const moved = await request(`/admin/manual-timetable/entries/${created.data.entry.id}`, {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ...selection, subjectId: alternateSubjectId, facultyId: alternateFaculty.id, roomId: lab.id, day: 'Tuesday', timeSlotId: tuesdaySlot.id, classType: 'LAB' },
  })
  assert.equal(moved.response.status, 200)
  assert.equal(moved.data.entry.day, 'Tuesday')
  assert.equal(moved.data.entry.subjectId, alternateSubjectId)
  assert.equal(moved.data.entry.facultyId, alternateFaculty.id)
  assert.equal(moved.data.entry.roomId, lab.id)
  assert.equal(moved.data.entry.classType, 'LAB')
  assert.equal(await database.collection('conflicts').countDocuments(), conflictsBefore)

  const deleted = await request(`/admin/manual-timetable/entries/${created.data.entry.id}`, { method: 'DELETE', token: departmentAdmin.token })
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.data.deleted, true)
  const empty = await request(`/admin/manual-timetable/entries?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.deepEqual(empty.data.entries, [])
  await database.collection('time_slots').deleteOne({ id: mondayLateSlotId })
})

test('creates a new timetable version, locks the published copy, and archives it after replacement', async () => {
  const departmentAdmin = await signIn('department.admin@demo.edu')
  const academicAdmin = await signIn('academic.admin@demo.edu')
  const department = await database.collection('departments').findOne({ name: 'Computer Science' })
  const academicYear = await database.collection('academic_years').findOne({ status: 'Active' })
  const program = await database.collection('programs').findOne({ departmentId: department.id, status: 'Active' })
  const batchId = await nextId(database, 'batches')
  const semesterId = await nextId(database, 'semesters')
  const sectionId = await nextId(database, 'sections')
  const subjectId = await nextId(database, 'subjects')
  await database.collection('batches').insertOne({
    id: batchId, name: 'Version Test Batch', code: 'VERSION-TEST', academicYearId: academicYear.id,
    departmentId: department.id, programId: program.id, status: 'Active',
  })
  await database.collection('semesters').insertOne({ id: semesterId, name: 'Version Test Semester', batchId, status: 'Active' })
  await database.collection('sections').insertOne({ id: sectionId, name: 'Version Test Section', code: 'VS', semesterId, studentCount: 10, status: 'Active' })
  await database.collection('subjects').insertOne({
    id: subjectId, code: 'VER 101', name: 'Versioned Subject', academicYearId: academicYear.id,
    departmentId: department.id, programId: program.id, batchId, semesterId,
    weeklyHours: 0, theoryHours: 0, practicalHours: 0, requiresLab: false, status: 'Active',
  })
  const faculty = await database.collection('users').findOne({ email: 'bello@demo.edu' })
  const rooms = await database.collection('rooms').find({ campusId: department.campusId, status: 'Active' }).sort({ id: 1 }).toArray()
  const timeSlot = await database.collection('time_slots').findOne({ day: 'Tuesday', type: 'CLASS', status: 'Active' })
  const selection = { academicYearId: academicYear.id, departmentId: department.id, programId: program.id, batchId, semesterId, sectionId }

  const initialVersions = await request(`/admin/manual-timetable/versions?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.equal(initialVersions.response.status, 200)
  const versionOne = initialVersions.data.versions[0]
  assert.equal(versionOne.versionNumber, 1)
  assert.equal(versionOne.status, 'Draft')
  const created = await request('/admin/manual-timetable/entries', {
    method: 'POST', token: departmentAdmin.token,
    body: { ...selection, versionId: versionOne.id, subjectId, facultyId: faculty.id, roomId: rooms[0].id, day: 'Tuesday', timeSlotId: timeSlot.id, classType: 'LECTURE' },
  })
  assert.equal(created.response.status, 201)
  const versionOneEntryId = created.data.entry.id

  for (const [token, status, details] of [
    [departmentAdmin.token, 'Awaiting approval', {}],
    [academicAdmin.token, 'Under review', {}],
    [academicAdmin.token, 'Approved', {}],
    [departmentAdmin.token, 'Published', {}],
  ]) {
    const transitioned = await request('/admin/schedules/status', {
      method: 'PATCH', token, body: { ids: [versionOneEntryId], status, ...details },
    })
    assert.ok(transitioned.response.status === 200, `${status}: ${JSON.stringify(transitioned.data)}`)
  }

  const publishedOne = await request(`/admin/manual-timetable/versions?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.equal(publishedOne.data.currentPublishedVersionId, versionOne.id)
  assert.equal(publishedOne.data.versions[0].status, 'Published')

  const createdVersion = await request('/admin/manual-timetable/versions', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(createdVersion.response.status, 201)
  const versionTwo = createdVersion.data.version
  assert.equal(versionTwo.versionNumber, 2)
  assert.equal(versionTwo.status, 'Draft')
  assert.equal(versionTwo.basedOnVersionId, versionOne.id)

  const copied = await request(`/admin/manual-timetable/entries?${new URLSearchParams({ ...selection, versionId: versionTwo.id })}`, { token: departmentAdmin.token })
  assert.equal(copied.data.entries.length, 1)
  const versionTwoEntry = copied.data.entries[0]
  assert.notEqual(versionTwoEntry.id, versionOneEntryId)
  assert.equal(versionTwoEntry.status, 'Draft')

  const lockedUpdate = await request(`/admin/manual-timetable/entries/${versionOneEntryId}`, {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ...selection, versionId: versionOne.id, subjectId, facultyId: faculty.id, roomId: rooms[0].id, day: 'Tuesday', timeSlotId: timeSlot.id, classType: 'LECTURE' },
  })
  assert.equal(lockedUpdate.response.status, 409)
  const lockedDelete = await request(`/admin/manual-timetable/entries/${versionOneEntryId}`, { method: 'DELETE', token: departmentAdmin.token })
  assert.equal(lockedDelete.response.status, 409)

  const movedVersionTwo = await request(`/admin/manual-timetable/entries/${versionTwoEntry.id}`, {
    method: 'PATCH', token: departmentAdmin.token,
    body: { ...selection, versionId: versionTwo.id, subjectId, facultyId: faculty.id, roomId: rooms.at(-1).id, day: 'Tuesday', timeSlotId: timeSlot.id, classType: 'LECTURE' },
  })
  assert.ok(movedVersionTwo.response.status === 200, JSON.stringify(movedVersionTwo.data))
  for (const [token, status] of [
    [departmentAdmin.token, 'Awaiting approval'],
    [academicAdmin.token, 'Under review'],
    [academicAdmin.token, 'Approved'],
    [departmentAdmin.token, 'Published'],
  ]) {
    const transitioned = await request('/admin/schedules/status', {
      method: 'PATCH', token, body: { ids: [versionTwoEntry.id], status },
    })
    assert.ok(transitioned.response.status === 200, `${status}: ${JSON.stringify(transitioned.data)}`)
  }

  const finalVersions = await request(`/admin/manual-timetable/versions?${new URLSearchParams(selection)}`, { token: departmentAdmin.token })
  assert.equal(finalVersions.data.currentPublishedVersionId, versionTwo.id)
  assert.equal(finalVersions.data.versions.find((version) => version.id === versionOne.id).status, 'Archived')
  assert.equal(finalVersions.data.versions.find((version) => version.id === versionTwo.id).status, 'Published')
  assert.equal((await database.collection('schedules').findOne({ id: versionOneEntryId })).status, 'Archived')
  assert.equal((await database.collection('schedules').findOne({ id: versionTwoEntry.id })).status, 'Published')
})

test('generates a valid draft timetable and reports failure without saving', async () => {
  const departmentAdmin = await signIn('department.admin@demo.edu')
  const department = await database.collection('departments').findOne({ name: 'Computer Science' })
  const academicYear = await database.collection('academic_years').findOne({ status: 'Active' })
  const program = await database.collection('programs').findOne({ departmentId: department.id, status: 'Active' })
  const batchId = await nextId(database, 'batches')
  const semesterId = await nextId(database, 'semesters')
  const sectionId = await nextId(database, 'sections')
  const oversizedSectionId = await nextId(database, 'sections')
  const unavailableSectionId = await nextId(database, 'sections')
  const lectureSubjectId = await nextId(database, 'subjects')
  const labSubjectId = await nextId(database, 'subjects')
  await database.collection('batches').insertOne({
    id: batchId, name: 'Generation Test Batch', code: 'GEN-TEST', academicYearId: academicYear.id,
    departmentId: department.id, programId: program.id, status: 'Active',
  })
  await database.collection('semesters').insertOne({ id: semesterId, name: 'Generation Test Semester', batchId, status: 'Active' })
  await database.collection('sections').insertMany([
    { id: sectionId, name: 'Generation Section', code: 'GS', semesterId, studentCount: 12, status: 'Active' },
    { id: oversizedSectionId, name: 'Oversized Section', code: 'OS', semesterId, studentCount: 1000, status: 'Active' },
    { id: unavailableSectionId, name: 'Unavailable Faculty Section', code: 'UF', semesterId, studentCount: 12, status: 'Active' },
  ])
  const lectureFaculty = await database.collection('users').findOne({ email: 'bello@demo.edu' })
  const labFaculty = lectureFaculty
  const generationSlotIds = [await nextId(database, 'time_slots'), await nextId(database, 'time_slots')]
  await database.collection('time_slots').insertMany([
    { id: generationSlotIds[0], day: 'Tuesday', start: '15:00', end: '16:00', type: 'CLASS', sequence: 90, status: 'Active' },
    { id: generationSlotIds[1], day: 'Tuesday', start: '16:00', end: '17:00', type: 'CLASS', sequence: 91, status: 'Active' },
  ])
  await database.collection('subjects').insertMany([
    {
      id: lectureSubjectId, code: 'GEN 101', name: 'Generated Lecture', type: 'Core',
      academicYearId: academicYear.id, departmentId: department.id, programId: program.id,
      batchId, semesterId, weeklyHours: 1, theoryHours: 1, practicalHours: 0,
      requiresLab: false, facultyId: lectureFaculty.id, status: 'Active',
    },
    {
      id: labSubjectId, code: 'GEN 102', name: 'Generated Lab', type: 'Core',
      academicYearId: academicYear.id, departmentId: department.id, programId: program.id,
      batchId, semesterId, weeklyHours: 1, theoryHours: 0, practicalHours: 1,
      requiresLab: true, facultyId: labFaculty.id, status: 'Active',
    },
  ])
  const selection = { academicYearId: academicYear.id, departmentId: department.id, programId: program.id, batchId, semesterId, sectionId }
  const generated = await request('/admin/manual-timetable/generate', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(generated.response.status, 201, JSON.stringify(generated.data))
  assert.equal(generated.data.generated, true)
  assert.equal(generated.data.count, 2)
  assert.equal(generated.data.validation.valid, true)
  assert.ok(generated.data.entries.every((entry) => entry.status === 'Draft'))
  assert.deepEqual(new Set(generated.data.entries.map((entry) => entry.classType)), new Set(['LECTURE', 'LAB']))
  const savedEntries = await database.collection('schedules').find({ sectionId }).toArray()
  assert.equal(savedEntries.length, 2)
  const validation = await request('/admin/manual-timetable/validate', {
    method: 'POST', token: departmentAdmin.token, body: selection,
  })
  assert.equal(validation.data.valid, true, JSON.stringify(validation.data))

  const beforeFailure = await database.collection('schedules').countDocuments()
  const failed = await request('/admin/manual-timetable/generate', {
    method: 'POST', token: departmentAdmin.token, body: { ...selection, sectionId: oversizedSectionId },
  })
  assert.equal(failed.response.status, 409)
  assert.equal(failed.data.generated, false)
  assert.ok(failed.data.conflicts.some((item) => item.type === 'ROOM_CAPACITY'))
  assert.equal(await database.collection('schedules').countDocuments(), beforeFailure)
  assert.equal(await database.collection('schedules').countDocuments({ sectionId: oversizedSectionId }), 0)

  await database.collection('users').updateMany({ id: { $in: [lectureFaculty.id, labFaculty.id] } }, { $set: { available: false } })
  const beforeUnavailableFailure = await database.collection('schedules').countDocuments()
  const unavailable = await request('/admin/manual-timetable/generate', {
    method: 'POST', token: departmentAdmin.token, body: { ...selection, sectionId: unavailableSectionId },
  })
  assert.equal(unavailable.response.status, 409)
  assert.ok(unavailable.data.conflicts.some((item) => item.type === 'FACULTY_UNAVAILABLE'))
  assert.equal(await database.collection('schedules').countDocuments(), beforeUnavailableFailure)
  await database.collection('users').updateMany({ id: { $in: [lectureFaculty.id, labFaculty.id] } }, { $set: { available: true } })
  await database.collection('time_slots').deleteMany({ id: { $in: generationSlotIds } })
})

test('reports each centralized timetable conflict independently', async (context) => {
  const baseCandidate = {
    departmentId: 900001, programId: 900002, day: 'Monday', start: '06:00', end: '07:00',
    facultyId: 900003,
    faculty: { id: 900003, name: 'Conflict Test Faculty', available: true, availabilityDays: 'Monday', unavailableSlots: [] },
    roomId: 900004, room: { id: 900004, name: 'Conflict Test Room', type: 'Classroom', capacity: 30 },
    sectionId: 900005, section: { id: 900005, name: 'Conflict Test Section', studentCount: 20 },
    subjectId: 900006, subject: { id: 900006, code: 'CT 101', name: 'Conflict Test Subject', weeklyHours: 10, theoryHours: 10 },
    classType: 'LECTURE', cohort: 'Conflict Test Section',
  }

  async function withExistingEntry(entry, candidate, expectedType) {
    const id = await nextId(database, 'schedules')
    await database.collection('schedules').insertOne({
      id, day: candidate.day, start: '06:30', end: '07:30', status: 'Draft', ...entry,
    })
    try {
      const result = await validateTimetableEntry(database, candidate)
      assert.equal(result.conflict, true)
      assert.equal(result.type, expectedType)
      assert.ok(result.message)
    } finally {
      await database.collection('schedules').deleteOne({ id })
    }
  }

  await context.test('faculty overlap', async () => {
    await withExistingEntry({ facultyId: baseCandidate.facultyId, roomId: 910001, sectionId: 910002 }, baseCandidate, 'FACULTY_CONFLICT')
  })
  await context.test('room overlap', async () => {
    await withExistingEntry({ facultyId: 910003, roomId: baseCandidate.roomId, sectionId: 910002 }, baseCandidate, 'ROOM_CONFLICT')
  })
  await context.test('section overlap', async () => {
    await withExistingEntry({ facultyId: 910003, roomId: 910001, sectionId: baseCandidate.sectionId }, baseCandidate, 'SECTION_CONFLICT')
  })
  await context.test('laboratory overlap', async () => {
    const candidate = { ...baseCandidate, roomId: 900007, room: { id: 900007, name: 'Conflict Test Lab', type: 'Laboratory', capacity: 30 } }
    await withExistingEntry({ facultyId: 910003, roomId: candidate.roomId, sectionId: 910002 }, candidate, 'LAB_CONFLICT')
  })
  await context.test('room capacity', async () => {
    const candidate = {
      ...baseCandidate, section: { ...baseCandidate.section, studentCount: 40 },
      room: { ...baseCandidate.room, capacity: 30 },
    }
    const result = await validateTimetableEntry(database, candidate)
    assert.equal(result.type, 'ROOM_CAPACITY')
  })
  await context.test('room capacity from legacy cohort enrollment', async () => {
    const id = await nextId(database, 'users')
    await database.collection('users').insertOne({
      id, email: 'conflict-capacity-student@demo.edu', role: 'student', status: 'Active',
      cohort: baseCandidate.cohort, programId: baseCandidate.programId,
    })
    try {
      const candidate = {
        ...baseCandidate, section: { id: baseCandidate.sectionId, name: 'Conflict Test Section' },
        room: { ...baseCandidate.room, capacity: 0 },
      }
      const result = await validateTimetableEntry(database, candidate)
      assert.equal(result.type, 'ROOM_CAPACITY')
    } finally {
      await database.collection('users').deleteOne({ id })
    }
  })
  await context.test('faculty unavailable period', async () => {
    const candidate = {
      ...baseCandidate,
      faculty: { ...baseCandidate.faculty, unavailableSlots: [{ day: 'Monday', start: '06:15', end: '06:45' }] },
    }
    const result = await validateTimetableEntry(database, candidate)
    assert.equal(result.type, 'FACULTY_UNAVAILABLE')
  })
  await context.test('break period', async () => {
    const id = await nextId(database, 'time_slots')
    await database.collection('time_slots').insertOne({ id, day: 'Monday', start: '09:00', end: '09:15', type: 'BREAK', status: 'Active' })
    try {
      const result = await validateTimetableEntry(database, { ...baseCandidate, start: '09:05', end: '09:10' })
      assert.equal(result.type, 'NON_CLASS_TIME_SLOT')
    } finally {
      await database.collection('time_slots').deleteOne({ id })
    }
  })
  await context.test('non-working day', async () => {
    const result = await validateTimetableEntry(database, { ...baseCandidate, day: 'Sunday' })
    assert.equal(result.type, 'NON_WORKING_DAY')
  })
  await context.test('weekly subject hours', async () => {
    const candidate = { ...baseCandidate, subject: { ...baseCandidate.subject, weeklyHours: 1, theoryHours: 1 } }
    await withExistingEntry({
      facultyId: 910003, roomId: 910001, sectionId: candidate.sectionId, subjectId: candidate.subjectId,
      start: '07:00', end: '07:30',
    }, candidate, 'WEEKLY_SUBJECT_HOURS')
  })
})

test('manages system directories, settings, analytics, and audit history', async () => {
  const superAdmin = await signIn('super.admin@demo.edu')
  const studentAccount = await request('/system/users', {
    method: 'POST',
    token: superAdmin.token,
    body: {
      name: 'Cohort Student',
      email: 'cohort.student@demo.edu',
      role: 'Student',
      department: 'Computer Science',
      program: 'Computer Science',
      cohort: 'Year 2 · Group A',
      campus: 'Main Campus',
      password: 'new-student-password',
    },
  })
  assert.equal(studentAccount.response.status, 201)
  assert.equal(studentAccount.data.record.program, 'Computer Science')

  const studentLogin = await request('/auth/login', {
    method: 'POST',
    body: { email: 'cohort.student@demo.edu', password: 'new-student-password' },
  })
  const studentTimetable = await request('/dashboard/timetable', { token: studentLogin.data.token })
  assert.equal(studentTimetable.data.summary.weekCount, 6)

  const campus = await request('/system/campuses', {
    method: 'POST',
    token: superAdmin.token,
    body: { name: 'Test Campus', code: 'TEST', location: 'Test District' },
  })
  assert.equal(campus.response.status, 201)
  assert.equal(campus.data.record.name, 'Test Campus')

  const campusUpdate = await request(`/system/campuses/${campus.data.record.id}`, {
    method: 'PATCH',
    token: superAdmin.token,
    body: { name: 'Test Campus', code: 'TEST', location: 'New District' },
  })
  assert.equal(campusUpdate.data.record.location, 'New District')

  const academicYear = await request('/system/academic-years', {
    method: 'POST',
    token: superAdmin.token,
    body: { name: '2027/2028', startDate: '2027-09-01', endDate: '2028-08-31' },
  })
  assert.equal(academicYear.response.status, 201)

  const settings = await request('/system/settings', {
    method: 'PUT',
    token: superAdmin.token,
    body: { institutionName: 'Test Institution', academicYear: '2027/2028', semester: 'Second semester', timeZone: 'UTC', conflictDetection: true, userRegistration: false, auditRetention: 365 },
  })
  assert.equal(settings.data.academicYear, '2027/2028')

  const analytics = await request('/system/analytics', { token: superAdmin.token })
  assert.equal(analytics.response.status, 200)
  assert.ok(analytics.data.departments > 0)

  const audit = await request('/system/audit', { token: superAdmin.token })
  assert.ok(audit.data.events.some((event) => event.action === 'Created campus'))
  assert.ok(audit.data.events.some((event) => event.action === 'Updated system settings'))
  assert.match(audit.data.events[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('manages the academic structure with validated parent relationships', async () => {
  const superAdmin = await signIn('super.admin@demo.edu')
  const student = await signIn('student@demo.edu')
  const years = await request('/system/academic-years', { token: superAdmin.token })
  const defaultYear = years.data.records.find((item) => item.name === '2026/2027')
  assert.ok(defaultYear)

  const academicYear = await request('/system/academic-years', {
    method: 'POST', token: superAdmin.token,
    body: { name: '2028/2029', startDate: '2028-09-01', endDate: '2029-08-31' },
  })
  assert.equal(academicYear.response.status, 201)
  const academicYearView = await request(`/system/academic-years/${academicYear.data.record.id}`, { token: superAdmin.token })
  assert.equal(academicYearView.data.record.name, '2028/2029')
  const academicYearEdit = await request(`/system/academic-years/${academicYear.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: '2028/2029 Revised', startDate: '2028-09-01', endDate: '2029-08-31' },
  })
  assert.equal(academicYearEdit.data.record.name, '2028/2029 Revised')

  const badDates = await request('/system/academic-years', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Invalid Dates', startDate: '2028-02-30', endDate: '2029-01-01' },
  })
  assert.equal(badDates.response.status, 400)

  const department = await request('/system/departments', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Structure Department', code: 'STR', campus: 'Main Campus', head: 'Dr. Structure', academicYearIds: [academicYear.data.record.id] },
  })
  assert.equal(department.response.status, 201)
  const departmentEdit = await request(`/system/departments/${department.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: department.data.record.name, code: department.data.record.code, campus: department.data.record.campus, head: 'Dr. Revised', academicYearIds: department.data.record.academicYearIds },
  })
  assert.equal(departmentEdit.data.record.head, 'Dr. Revised')
  const blockedYearDeactivation = await request(`/system/academic-years/${academicYear.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(blockedYearDeactivation.response.status, 409)

  const badDepartmentYear = await request('/system/departments', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Bad Year Department', code: 'BAD-Y', campus: 'Main Campus', academicYearIds: [999999] },
  })
  assert.equal(badDepartmentYear.response.status, 400)

  const program = await request('/system/programs', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Structure Program', code: 'STR-P', departmentId: department.data.record.id, level: 'Bachelor' },
  })
  assert.equal(program.response.status, 201)
  const programView = await request(`/system/programs/${program.data.record.id}`, { token: superAdmin.token })
  assert.equal(programView.data.record.departmentId, department.data.record.id)
  const programEdit = await request(`/system/programs/${program.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: program.data.record.name, code: program.data.record.code, departmentId: department.data.record.id, level: 'Master' },
  })
  assert.equal(programEdit.data.record.level, 'Master')
  const blockedDepartmentDeactivation = await request(`/system/departments/${department.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(blockedDepartmentDeactivation.response.status, 409)

  const wrongDepartmentProgram = await request('/system/programs', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Bad Program', code: 'BAD-P', departmentId: 999999, level: 'Bachelor' },
  })
  assert.equal(wrongDepartmentProgram.response.status, 400)

  const batch = await request('/system/batches', {
    method: 'POST', token: superAdmin.token,
    body: { name: '2028 Intake', code: '2028', academicYearId: academicYear.data.record.id, departmentId: department.data.record.id, programId: program.data.record.id },
  })
  assert.equal(batch.response.status, 201)
  const batchEdit = await request(`/system/batches/${batch.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: '2028 Intake Revised', code: '2028-R', academicYearId: academicYear.data.record.id, departmentId: department.data.record.id, programId: program.data.record.id },
  })
  assert.equal(batchEdit.data.record.name, '2028 Intake Revised')
  const batchView = await request(`/system/batches/${batch.data.record.id}`, { token: superAdmin.token })
  assert.equal(batchView.data.record.programId, program.data.record.id)
  const blockedProgramDeactivation = await request(`/system/programs/${program.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(blockedProgramDeactivation.response.status, 409)

  const invalidBatchParent = await request('/system/batches', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Invalid Intake', code: 'INV', academicYearId: academicYear.data.record.id, departmentId: defaultYear.id, programId: program.data.record.id },
  })
  assert.equal(invalidBatchParent.response.status, 400)

  const semester = await request('/system/semesters', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'First semester', batchId: batch.data.record.id, startDate: '2028-09-10', endDate: '2029-01-20' },
  })
  assert.equal(semester.response.status, 201)
  const semesterEdit = await request(`/system/semesters/${semester.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: 'Term One', batchId: batch.data.record.id, startDate: '2028-09-10', endDate: '2029-01-20' },
  })
  assert.equal(semesterEdit.data.record.name, 'Term One')
  const blockedBatchDeactivation = await request(`/system/batches/${batch.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(blockedBatchDeactivation.response.status, 409)
  const invalidAcademicYearEdit = await request(`/system/academic-years/${academicYear.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: '2028/2029 Revised', startDate: '2028-09-01', endDate: '2028-12-31' },
  })
  assert.equal(invalidAcademicYearEdit.response.status, 409)

  const invalidSemesterDates = await request('/system/semesters', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Out of year', batchId: batch.data.record.id, startDate: '2029-09-10', endDate: '2030-01-20' },
  })
  assert.equal(invalidSemesterDates.response.status, 400)

  const section = await request('/system/sections', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Section A', code: 'A', semesterId: semester.data.record.id },
  })
  assert.equal(section.response.status, 201)
  const semesterView = await request(`/system/semesters/${semester.data.record.id}`, { token: superAdmin.token })
  assert.equal(semesterView.data.record.batchId, batch.data.record.id)
  const sectionView = await request(`/system/sections/${section.data.record.id}`, { token: superAdmin.token })
  assert.equal(sectionView.data.record.semesterId, semester.data.record.id)
  const blockedSemesterDeactivation = await request(`/system/semesters/${semester.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(blockedSemesterDeactivation.response.status, 409)

  const invalidSectionParent = await request('/system/sections', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Invalid Section', code: 'X', semesterId: 999999 },
  })
  assert.equal(invalidSectionParent.response.status, 400)

  const forbidden = await request('/system/batches', { token: student.token })
  assert.equal(forbidden.response.status, 403)

  const sectionUpdate = await request(`/system/sections/${section.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { name: 'Section B', code: 'B', semesterId: semester.data.record.id },
  })
  assert.equal(sectionUpdate.data.record.name, 'Section B')
  const sectionDeactivation = await request(`/system/sections/${section.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(sectionDeactivation.data.record.status, 'Inactive')
  const sectionReactivation = await request(`/system/sections/${section.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Active' },
  })
  assert.equal(sectionReactivation.data.record.status, 'Active')

  const blockedBatchDelete = await request(`/system/batches/${batch.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(blockedBatchDelete.response.status, 409)
  const blockedDepartmentDelete = await request(`/system/departments/${department.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(blockedDepartmentDelete.response.status, 409)

  const deletedSection = await request(`/system/sections/${section.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(deletedSection.data.deleted, true)
  assert.equal((await request(`/system/semesters/${semester.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/batches/${batch.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/programs/${program.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/departments/${department.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/academic-years/${academicYear.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
})

test('manages subjects end-to-end with academic and faculty validation', async () => {
  const superAdmin = await signIn('super.admin@demo.edu')
  const student = await signIn('student@demo.edu')
  const year = (await request('/system/academic-years', { token: superAdmin.token })).data.records.find((item) => item.name === '2026/2027')
  const department = (await request('/system/departments', { token: superAdmin.token })).data.records.find((item) => item.name === 'Computer Science')
  const programs = (await request('/system/programs', { token: superAdmin.token })).data.records
  const program = programs.find((item) => item.departmentId === department.id)
  const otherProgram = programs.find((item) => item.departmentId === department.id && item.id !== program.id)
  const otherDepartment = (await request('/system/departments', { token: superAdmin.token })).data.records.find((item) => item.id !== department.id)
  const faculty = await database.collection('users').findOne({ email: 'faculty@demo.edu' })
  const facultyFromOtherDepartment = await database.collection('users').findOne({ email: 'adeyemi@demo.edu' })

  const batch = await request('/system/batches', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Subject Test Intake', code: 'SUBJ-TEST', academicYearId: year.id, departmentId: department.id, programId: program.id },
  })
  assert.equal(batch.response.status, 201)
  const semester = await request('/system/semesters', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Subject Test Semester', batchId: batch.data.record.id },
  })
  assert.equal(semester.response.status, 201)
  const otherBatch = await request('/system/batches', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Other Subject Intake', code: 'SUBJ-OTHER', academicYearId: year.id, departmentId: department.id, programId: otherProgram.id },
  })
  assert.equal(otherBatch.response.status, 201)
  const otherSemester = await request('/system/semesters', {
    method: 'POST', token: superAdmin.token,
    body: { name: 'Other Subject Semester', batchId: otherBatch.data.record.id },
  })
  assert.equal(otherSemester.response.status, 201)

  const subjectInput = {
    code: 'CSC 902', name: 'Subject CRUD Test', credits: 3, type: 'Core',
    academicYearId: year.id, departmentId: department.id, programId: program.id,
    batchId: batch.data.record.id, semesterId: semester.data.record.id,
    weeklyHours: 4, theoryHours: 3, practicalHours: 1, facultyId: faculty.id, requiresLab: true,
  }
  const invalidRequiredFields = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, name: '' },
  })
  assert.equal(invalidRequiredFields.response.status, 400)

  const invalidHours = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, weeklyHours: 5 },
  })
  assert.equal(invalidHours.response.status, 400)

  const labWithoutPractical = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, practicalHours: 0, theoryHours: 4 },
  })
  assert.equal(labWithoutPractical.response.status, 400)

  const invalidProgramParent = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, departmentId: otherDepartment.id },
  })
  assert.equal(invalidProgramParent.response.status, 400)

  const invalidSemesterParent = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, semesterId: otherSemester.data.record.id },
  })
  assert.equal(invalidSemesterParent.response.status, 400)

  const invalidFaculty = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token,
    body: { ...subjectInput, facultyId: (await database.collection('users').findOne({ email: 'student@demo.edu' })).id },
  })
  assert.equal(invalidFaculty.response.status, 400)
  const crossDepartmentFaculty = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token,
    body: { ...subjectInput, facultyId: facultyFromOtherDepartment.id },
  })
  assert.equal(crossDepartmentFaculty.response.status, 400)

  const created = await request('/system/subjects', { method: 'POST', token: superAdmin.token, body: subjectInput })
  assert.equal(created.response.status, 201)
  assert.equal(created.data.record.faculty, faculty.name)
  assert.equal(created.data.record.semesterId, semester.data.record.id)
  assert.equal(created.data.record.requiresLab, true)
  const protectedFaculty = await request(`/system/users/${faculty.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(protectedFaculty.response.status, 409)

  const duplicateCode = await request('/system/subjects', {
    method: 'POST', token: superAdmin.token, body: { ...subjectInput, name: 'Duplicate Code' },
  })
  assert.equal(duplicateCode.response.status, 409)

  const listed = await request('/system/subjects', { token: superAdmin.token })
  assert.ok(listed.data.records.some((item) => item.id === created.data.record.id))
  const viewed = await request(`/system/subjects/${created.data.record.id}`, { token: superAdmin.token })
  assert.equal(viewed.data.record.code, 'CSC 902')

  const forbidden = await request('/system/subjects', { token: student.token })
  assert.equal(forbidden.response.status, 403)

  const edited = await request(`/system/subjects/${created.data.record.id}`, {
    method: 'PATCH', token: superAdmin.token,
    body: { ...subjectInput, name: 'Edited Subject', credits: 4, facultyId: '' },
  })
  assert.equal(edited.data.record.name, 'Edited Subject')
  assert.equal(edited.data.record.credits, 4)
  assert.equal(edited.data.record.facultyId, null)

  const deactivated = await request(`/system/subjects/${created.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Inactive' },
  })
  assert.equal(deactivated.data.record.status, 'Inactive')
  const reactivated = await request(`/system/subjects/${created.data.record.id}/status`, {
    method: 'PATCH', token: superAdmin.token, body: { status: 'Active' },
  })
  assert.equal(reactivated.data.record.status, 'Active')

  await database.collection('schedules').insertOne({ id: 99999, subjectId: created.data.record.id })
  const blockedDelete = await request(`/system/subjects/${created.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(blockedDelete.response.status, 409)
  await database.collection('schedules').deleteOne({ subjectId: created.data.record.id })

  const deleted = await request(`/system/subjects/${created.data.record.id}`, { method: 'DELETE', token: superAdmin.token })
  assert.equal(deleted.data.deleted, true)
  const missing = await request(`/system/subjects/${created.data.record.id}`, { token: superAdmin.token })
  assert.equal(missing.response.status, 404)
  assert.equal((await request(`/system/semesters/${semester.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/batches/${batch.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/semesters/${otherSemester.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
  assert.equal((await request(`/system/batches/${otherBatch.data.record.id}`, { method: 'DELETE', token: superAdmin.token })).data.deleted, true)
})

test('lets a super admin add and remove faculty request form fields', async () => {
  const superAdmin = await signIn('super.admin@demo.edu')
  const faculty = await signIn('faculty@demo.edu')
  const student = await signIn('student@demo.edu')

  const denied = await request('/system/request-form-fields', { token: student.token })
  assert.equal(denied.response.status, 403)

  const initial = await request('/system/request-form-fields', { token: superAdmin.token })
  assert.equal(initial.response.status, 200)
  assert.deepEqual(initial.data.change.map((field) => field.key), ['scheduleId', 'proposedChange', 'reason'])
  assert.deepEqual(initial.data.leave.map((field) => field.key), ['leaveType', 'startDate', 'endDate', 'reason'])
  assert.equal(initial.data.change[0].locked, true)
  assert.equal(initial.data.leave[0].type, 'select')

  const trimmedChange = initial.data.change
    .filter((field) => field.key !== 'reason')
    .map(({ id, label, type, required, placeholder, options }) => ({ id, label, type, required, placeholder, options }))
  trimmedChange.push({ label: 'Preferred day', type: 'select', required: true, options: ['Monday', 'Friday'] })
  const saved = await request('/system/request-form-fields', {
    method: 'PUT', token: superAdmin.token, body: { form: 'change', fields: trimmedChange },
  })
  assert.equal(saved.response.status, 200)
  assert.deepEqual(saved.data.change.map((field) => field.label), ['Assigned class or lab', 'Requested change', 'Preferred day'])
  assert.equal(saved.data.change[2].key, 'custom_preferred_day')

  const removingLocked = await request('/system/request-form-fields', {
    method: 'PUT',
    token: superAdmin.token,
    body: { form: 'change', fields: [{ id: saved.data.change[1].id, label: 'Requested change', type: 'textarea', required: true }] },
  })
  assert.equal(removingLocked.response.status, 400)
  const unchanged = await request('/system/request-form-fields', { token: superAdmin.token })
  assert.deepEqual(unchanged.data.change.map((field) => field.key), ['scheduleId', 'proposedChange', 'custom_preferred_day'])

  const facultyFields = await request('/dashboard/request-form-fields', { token: faculty.token })
  assert.equal(facultyFields.response.status, 200)
  assert.deepEqual(facultyFields.data.change.map((field) => field.key), ['scheduleId', 'proposedChange', 'custom_preferred_day'])

  const schedule = await database.collection('schedules').findOne({ facultyId: faculty.user.id, status: 'Published' })
  const submitted = await request('/dashboard/change-requests', {
    method: 'POST',
    token: faculty.token,
    body: { scheduleId: schedule.id, proposedChange: 'Move to Friday', custom_preferred_day: 'Friday' },
  })
  assert.equal(submitted.response.status, 201)
  assert.deepEqual(submitted.data.customFields, [{ key: 'custom_preferred_day', label: 'Preferred day', value: 'Friday' }])

  const missingChoice = await request('/dashboard/change-requests', {
    method: 'POST', token: faculty.token, body: { scheduleId: schedule.id, proposedChange: 'Move to Friday' },
  })
  assert.equal(missingChoice.response.status, 400)

  const restored = await request('/system/request-form-fields', {
    method: 'PUT', token: superAdmin.token, body: { form: 'change', restoreDefaults: true },
  })
  assert.equal(restored.response.status, 200)
  assert.deepEqual(restored.data.change.map((field) => field.key), ['scheduleId', 'proposedChange', 'reason'])
  assert.equal(restored.data.change[0].type, 'class')
})