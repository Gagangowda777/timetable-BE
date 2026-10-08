import { HttpError } from '../utils/httpError.js'
import { writeAudit } from './auditModel.js'
import { insertRecord } from './dataHelpers.js'
import { collectCustomValues, getRequestFormConfig } from './requestFormModel.js'

export async function createFacultyChangeRequest(database, user, input) {
  const config = await getRequestFormConfig(database, 'change')
  // A field only has to be filled in when the super admin left it on the form as required.
  const isRequired = (key, fallback) => (config.isLegacy ? fallback : Boolean(config.byKey.get(key)?.required))
  const scheduleId = Number(input.scheduleId)
  const proposedChange = typeof input.proposedChange === 'string' ? input.proposedChange.trim() : ''
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!Number.isInteger(scheduleId) || scheduleId < 1) {
    throw new HttpError(400, 'Choose a class and describe the requested change and reason.')
  }
  if ((isRequired('proposedChange', true) && !proposedChange) || (isRequired('reason', true) && !reason)) {
    throw new HttpError(400, 'Choose a class and describe the requested change and reason.')
  }
  if (proposedChange.length > 1000 || reason.length > 1000) {
    throw new HttpError(400, 'Change details and reason must be 1000 characters or fewer.')
  }
  const customFields = collectCustomValues(config, input)

  const schedule = await database.collection('schedules').findOne({
    id: scheduleId, facultyId: user.id, status: 'Published',
  })
  if (!schedule) throw new HttpError(404, 'Published class not found for this faculty account.')

  const id = await insertRecord(database, 'change_requests', {
    facultyId: user.id,
    facultyName: user.name,
    departmentId: schedule.departmentId,
    scheduleId: schedule.id,
    subject: schedule.subject,
    code: schedule.code,
    day: schedule.day,
    start: schedule.start,
    end: schedule.end,
    proposedChange,
    reason,
    customFields,
    status: 'Pending',
  })
  return database.collection('change_requests').findOne({ id })
}

export async function getFacultyChangeRequests(database, user) {
  return database.collection('change_requests').find({ facultyId: user.id }).sort({ createdAt: -1 }).toArray()
}

export async function getAdminChangeRequests(database, user) {
  const filter = user.role === 'department-admin' ? { departmentId: user.departmentId } : {}
  return database.collection('change_requests').find(filter).sort({ createdAt: -1 }).toArray()
}

export async function reviewFacultyChangeRequest(database, user, requestId, status) {
  if (!['Approved', 'Declined'].includes(status)) {
    throw new HttpError(400, 'Choose Approved or Declined as the review outcome.')
  }

  const id = Number(requestId)
  const changeRequest = await database.collection('change_requests').findOne({ id })
  if (!changeRequest) throw new HttpError(404, 'Change request not found.')
  if (user.role === 'department-admin' && changeRequest.departmentId !== user.departmentId) {
    throw new HttpError(403, 'You can only review requests from your department.')
  }
  if (changeRequest.status !== 'Pending') throw new HttpError(409, 'This change request has already been reviewed.')

  await database.collection('change_requests').updateOne({ id, status: 'Pending' }, {
    $set: { status, reviewedBy: user.name, reviewedAt: new Date() },
  })
  await writeAudit(database, {
    actorId: user.id,
    actorName: user.name,
    action: `${status.toLowerCase()} timetable change request`,
    target: `${changeRequest.subject} (${changeRequest.code})`,
    details: changeRequest.proposedChange,
  })
  return database.collection('change_requests').findOne({ id })
}