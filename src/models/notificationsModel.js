import { insertRecord } from './dataHelpers.js'

export async function getStudentNotifications(database, user) {
  const notifications = await database.collection('notifications').find({ userId: user.id }).sort({ createdAt: -1 }).limit(20).toArray()
  return {
    notifications: notifications.map(({ id, title, message, createdAt }) => ({ id, title, message, createdAt })),
  }
}

export async function notifyStudentsOfPublishedSchedules(database, schedules) {
  const departmentIds = [...new Set(schedules.map((schedule) => schedule.departmentId))]
  const students = await database.collection('users').find({
    role: 'student', status: 'Active',
    departmentId: { $in: departmentIds },
  }).toArray()

  const notifications = []
  for (const student of students) {
    for (const schedule of schedules) {
      const matchesProgram = !schedule.programId || !student.programId || schedule.programId === student.programId
      const matchesCohort = !schedule.cohort || schedule.cohort === student.cohort
      if (schedule.departmentId !== student.departmentId || !matchesProgram || !matchesCohort) continue
      notifications.push(insertRecord(database, 'notifications', {
        userId: student.id,
        scheduleId: schedule.id,
        title: `Timetable updated: ${schedule.subject}`,
        message: `${schedule.code} is scheduled for ${schedule.day} at ${schedule.start}-${schedule.end}.`,
      }))
    }
  }
  await Promise.all(notifications)
}