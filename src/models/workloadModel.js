import { HttpError } from '../utils/httpError.js'

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const underUtilizedBelow = 50
const highUtilizationFrom = 85

function durationMinutes(start, end) {
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (!timePattern.test(start || '') || !timePattern.test(end || '')) return 0
  const [startHour, startMinute] = start.split(':').map(Number)
  const [endHour, endMinute] = end.split(':').map(Number)
  return Math.max(0, endHour * 60 + endMinute - startHour * 60 - startMinute)
}

function rounded(value, decimals = 1) {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

function getWorkloadStatus(utilizationPercentage, maximumAllowedHours) {
  if (!maximumAllowedHours) return 'Under-utilized'
  if (utilizationPercentage > 100) return 'Overloaded'
  if (utilizationPercentage >= highUtilizationFrom) return 'High'
  if (utilizationPercentage < underUtilizedBelow) return 'Under-utilized'
  return 'Normal'
}

function summarizeFacultyWorkload(faculty, schedules, departmentName) {
  const dailyMinutes = new Map(weekdays.map((day) => [day, 0]))
  const dailyClasses = new Map(weekdays.map((day) => [day, 0]))
  let weeklyMinutes = 0
  for (const schedule of schedules) {
    const minutes = durationMinutes(schedule.start, schedule.end)
    weeklyMinutes += minutes
    if (dailyMinutes.has(schedule.day)) {
      dailyMinutes.set(schedule.day, dailyMinutes.get(schedule.day) + minutes)
      dailyClasses.set(schedule.day, dailyClasses.get(schedule.day) + 1)
    }
  }
  const maximumAllowedHours = Number.isFinite(Number(faculty.maxTeachingHours))
    ? Number(faculty.maxTeachingHours)
    : 0
  const weeklyTeachingHours = rounded(weeklyMinutes / 60, 2)
  const utilizationPercentage = maximumAllowedHours > 0
    ? rounded((weeklyTeachingHours / maximumAllowedHours) * 100)
    : 0
  return {
    facultyId: faculty.id,
    faculty: faculty.name,
    email: faculty.email,
    departmentId: faculty.departmentId,
    department: departmentName || '',
    weeklyTeachingHours,
    dailyTeachingHours: weekdays.map((day) => ({
      day, hours: rounded((dailyMinutes.get(day) || 0) / 60, 2), classes: dailyClasses.get(day) || 0,
    })),
    numberOfClasses: schedules.length,
    maximumAllowedHours,
    utilizationPercentage,
    workloadStatus: getWorkloadStatus(utilizationPercentage, maximumAllowedHours),
  }
}

async function calculateFacultyWorkloads(database, faculty) {
  if (!faculty.length) return []
  const facultyIds = faculty.map((item) => item.id)
  const [schedules, departments] = await Promise.all([
    database.collection('schedules').find({ facultyId: { $in: facultyIds }, status: 'Published' })
      .project({ id: 1, facultyId: 1, day: 1, start: 1, end: 1 }).toArray(),
    database.collection('departments').find({ id: { $in: faculty.map((item) => item.departmentId).filter(Boolean) } })
      .project({ id: 1, name: 1 }).toArray(),
  ])
  const schedulesByFaculty = new Map(facultyIds.map((id) => [id, []]))
  for (const schedule of schedules) schedulesByFaculty.get(schedule.facultyId)?.push(schedule)
  const departmentsById = new Map(departments.map((department) => [department.id, department.name]))
  return faculty.map((item) => summarizeFacultyWorkload(item, schedulesByFaculty.get(item.id) || [], departmentsById.get(item.departmentId)))
    .sort((left, right) => left.faculty.localeCompare(right.faculty))
}

function summarizeWorkloads(facultyWorkloads) {
  const statusCounts = { Normal: 0, High: 0, Overloaded: 0, 'Under-utilized': 0 }
  for (const item of facultyWorkloads) statusCounts[item.workloadStatus] += 1
  const configured = facultyWorkloads.filter((item) => item.maximumAllowedHours > 0)
  return {
    facultyCount: facultyWorkloads.length,
    facultyWithClasses: facultyWorkloads.filter((item) => item.numberOfClasses > 0).length,
    totalWeeklyTeachingHours: rounded(facultyWorkloads.reduce((sum, item) => sum + item.weeklyTeachingHours, 0), 2),
    totalClasses: facultyWorkloads.reduce((sum, item) => sum + item.numberOfClasses, 0),
    averageUtilizationPercentage: configured.length
      ? rounded(configured.reduce((sum, item) => sum + item.utilizationPercentage, 0) / configured.length)
      : 0,
    ...statusCounts,
  }
}

export async function getFacultyWorkload(database, facultyId) {
  const faculty = await database.collection('users').findOne({ id: Number(facultyId), role: 'faculty', status: 'Active' })
  if (!faculty) throw new HttpError(404, 'Faculty member not found.')
  const [workload] = await calculateFacultyWorkloads(database, [faculty])
  return workload
}

export async function getFacultyWorkloadReport(database, user, requestedDepartmentId) {
  const query = { role: 'faculty', status: 'Active' }
  if (user.role === 'department-admin') query.departmentId = user.departmentId
  else if (requestedDepartmentId) {
    const departmentId = Number(requestedDepartmentId)
    if (!Number.isSafeInteger(departmentId) || departmentId < 1) throw new HttpError(400, 'Choose a valid department.')
    query.departmentId = departmentId
  }
  const faculty = await database.collection('users').find(query).toArray()
  const workloads = await calculateFacultyWorkloads(database, faculty)
  return {
    faculty: workloads,
    summary: summarizeWorkloads(workloads),
    overloadedFaculty: workloads.filter((item) => item.workloadStatus === 'Overloaded'),
  }
}