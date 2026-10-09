import {
  createDepartmentSchedule,
  getAdminBootstrap,
  getCalendarData,
  getManualTimetableOptions,
  listManualTimetableEntries,
  validateManualTimetable,
  getManualTimetableVersions,
  createManualTimetableVersion,
  createManualTimetableEntry,
  updateManualTimetableEntry,
  deleteManualTimetableEntry,
  getScheduleReport,
  saveAcademicCalendar,
  setFacultyAvailability,
  setScheduleStatus,
} from '../models/adminModel.js'
import { getAdminChangeRequests, reviewFacultyChangeRequest } from '../models/changeRequestModel.js'
import { getAdminLeaveRequests, reviewFacultyLeaveRequest } from '../models/leaveRequestModel.js'
import { generateManualTimetable } from '../services/timetableGenerationService.js'
import { resolveScheduleConflict } from '../services/conflictResolutionService.js'
import { getFacultyWorkload, getFacultyWorkloadReport } from '../models/workloadModel.js'
import { HttpError } from '../utils/httpError.js'

export async function bootstrap(request, response) {
  response.json(await getAdminBootstrap(request.app.locals.database, request.user, request.query.departmentId))
}

export async function createSchedule(request, response) {
  if (request.user.role !== 'department-admin') throw new HttpError(403, 'Only Department Admins can create department timetable entries.')
  response.status(201).json(await createDepartmentSchedule(request.app.locals.database, request.user, request.body))
}

export async function updateScheduleStatus(request, response) {
  response.json(await setScheduleStatus(
    request.app.locals.database, request.user, request.body.ids, request.body.status, request.body,
  ))
}

export async function updateFacultyAvailability(request, response) {
  response.json(await setFacultyAvailability(request.app.locals.database, request.user, request.params.id, request.body.available))
}

export async function resolveConflict(request, response) {
  response.json(await resolveScheduleConflict(request.app.locals.database, request.user, request.params.id))
}

export async function getCalendar(request, response) {
  response.json(await getCalendarData(request.app.locals.database))
}

export async function updateCalendar(request, response) {
  response.json(await saveAcademicCalendar(request.app.locals.database, request.user, request.body))
}

export async function manualTimetableOptions(request, response) {
  response.json(await getManualTimetableOptions(request.app.locals.database, request.user, request.query))
}

export async function manualTimetableEntries(request, response) {
  response.json(await listManualTimetableEntries(request.app.locals.database, request.user, request.query))
}

export async function validateManualTimetableController(request, response) {
  response.json(await validateManualTimetable(request.app.locals.database, request.user, request.body))
}

export async function createManualTimetableVersionController(request, response) {
  response.status(201).json(await createManualTimetableVersion(request.app.locals.database, request.user, request.body))
}

export async function manualTimetableVersions(request, response) {
  response.json(await getManualTimetableVersions(request.app.locals.database, request.user, request.query))
}

export async function generateManualTimetableController(request, response) {
  const result = await generateManualTimetable(request.app.locals.database, request.user, request.body)
  if (!result.generated) {
    response.status(409).json({ error: 'A complete valid timetable could not be generated.', ...result })
    return
  }
  response.status(201).json(result)
}

export async function createManualTimetableEntryController(request, response) {
  response.status(201).json(await createManualTimetableEntry(request.app.locals.database, request.user, request.body))
}

export async function updateManualTimetableEntryController(request, response) {
  response.json(await updateManualTimetableEntry(request.app.locals.database, request.user, request.params.id, request.body))
}

export async function deleteManualTimetableEntryController(request, response) {
  response.json(await deleteManualTimetableEntry(request.app.locals.database, request.user, request.params.id))
}

export async function reports(request, response) {
  response.json({ schedules: await getScheduleReport(request.app.locals.database, request.user) })
}

export async function changeRequests(request, response) {
  response.json(await getAdminChangeRequests(request.app.locals.database, request.user))
}

export async function reviewChangeRequest(request, response) {
  response.json(await reviewFacultyChangeRequest(
    request.app.locals.database,
    request.user,
    request.params.id,
    request.body.status,
  ))
}

export async function leaveRequests(request, response) {
  response.json(await getAdminLeaveRequests(request.app.locals.database, request.user))
}

export async function reviewLeaveRequest(request, response) {
  response.json(await reviewFacultyLeaveRequest(
    request.app.locals.database,
    request.user,
    request.params.id,
    request.body.status,
  ))
}

export async function facultyWorkloadReport(request, response) {
  response.json(await getFacultyWorkloadReport(
    request.app.locals.database, request.user, request.query.departmentId,
  ))
}

export async function facultyWorkloadDetails(request, response) {
  response.json(await getFacultyWorkload(request.app.locals.database, request.params.id))
}