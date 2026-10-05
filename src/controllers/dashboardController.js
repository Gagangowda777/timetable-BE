import { getDashboardTimetable } from '../models/dashboardModel.js'
import { getStudentNotifications } from '../models/notificationsModel.js'
import { createFacultyChangeRequest, getFacultyChangeRequests } from '../models/changeRequestModel.js'
import { getFacultyWorkload } from '../models/workloadModel.js'
import { createFacultyLeaveRequest, getFacultyLeaveRequests } from '../models/leaveRequestModel.js'

export async function timetable(request, response) {
  const data = await getDashboardTimetable(request.app.locals.database, request.user, request.query.weekOffset)
  response.json(data)
}

export async function notifications(request, response) {
  response.json(await getStudentNotifications(request.app.locals.database, request.user))
}

export async function facultyChangeRequests(request, response) {
  response.json(await getFacultyChangeRequests(request.app.locals.database, request.user))
}

export async function createFacultyChange(request, response) {
  const changeRequest = await createFacultyChangeRequest(request.app.locals.database, request.user, request.body)
  response.status(201).json(changeRequest)
}

export async function facultyWorkload(request, response) {
  response.json(await getFacultyWorkload(request.app.locals.database, request.user.id))
}

export async function facultyLeaveRequests(request, response) {
  response.json(await getFacultyLeaveRequests(request.app.locals.database, request.user))
}

export async function createFacultyLeave(request, response) {
  const leaveRequest = await createFacultyLeaveRequest(request.app.locals.database, request.user, request.body)
  response.status(201).json(leaveRequest)
}
