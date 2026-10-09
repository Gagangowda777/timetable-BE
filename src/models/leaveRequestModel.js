import { HttpError } from '../utils/httpError.js'
import { writeAudit } from './auditModel.js'
import { insertRecord } from './dataHelpers.js'
import { collectCustomValues, getRequestFormConfig } from './requestFormModel.js'

export const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Other']

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function normalizeDate(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!DATE_PATTERN.test(text)) return null
  const parsed = new Date(`${text}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : text
}

export async function createFacultyLeaveRequest(database, user, input) {
  const config = await getRequestFormConfig(database, 'leave')
  // A field only has to be filled in when the super admin left it on the form as required.
  const isRequired = (key, fallback) => (config.isLegacy ? fallback : Boolean(config.byKey.get(key)?.required))
  const configuredType = config.byKey.get('leaveType')
  const allowedTypes = config.isLegacy || !configuredType?.options?.length ? LEAVE_TYPES : configuredType.options
  const leaveType = typeof input.leaveType === 'string' ? input.leaveType.trim() : ''
  const startDate = normalizeDate(input.startDate)
  const endDate = normalizeDate(input.endDate)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''

  if (isRequired('leaveType', true) && !allowedTypes.includes(leaveType)) {
    throw new HttpError(400, 'Choose a valid leave type.')
  }
  if (leaveType && !allowedTypes.includes(leaveType)) throw new HttpError(400, 'Choose a valid leave type.')
  if (isRequired('startDate', true) && !startDate) throw new HttpError(400, 'Choose a valid start date.')
  if (isRequired('endDate', true) && !endDate) throw new HttpError(400, 'Choose a valid end date.')
  if (Boolean(startDate) !== Boolean(endDate) && (isRequired('startDate', true) || isRequired('endDate', true))) {
    throw new HttpError(400, 'Choose a valid start and end date.')
  }
  if (startDate && endDate && endDate < startDate) throw new HttpError(400, 'The end date cannot be before the start date.')
  if (isRequired('reason', true) && !reason) throw new HttpError(400, 'Describe the reason for your leave.')
  if (reason.length > 1000) throw new HttpError(400, 'The reason must be 1000 characters or fewer.')

  const customFields = collectCustomValues(config, input)
  const numberOfDays = startDate && endDate
    ? Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1
    : 0

  const id = await insertRecord(database, 'leave_requests', {
    facultyId: user.id,
    facultyName: user.name,
    departmentId: user.departmentId ?? null,
    leaveType: leaveType || 'Other',
    startDate: startDate || '',
    endDate: endDate || '',
    numberOfDays,
    reason,
    customFields,
    status: 'Pending',
  })
  await writeAudit(database, {
    actorId: user.id,
    actorName: user.name,
    action: 'Submitted leave request',
    target: `${leaveType} · ${startDate} to ${endDate}`,
    details: reason,
  })
  return database.collection('leave_requests').findOne({ id })
}

export async function getFacultyLeaveRequests(database, user) {
  return database.collection('leave_requests').find({ facultyId: user.id }).sort({ createdAt: -1 }).toArray()
}

export async function getAdminLeaveRequests(database, user) {
  const filter = user.role === 'department-admin' ? { departmentId: user.departmentId } : {}
  return database.collection('leave_requests').find(filter).sort({ createdAt: -1 }).toArray()
}

export async function reviewFacultyLeaveRequest(database, user, requestId, status) {
  if (!['Approved', 'Declined'].includes(status)) {
    throw new HttpError(400, 'Choose Approved or Declined as the review outcome.')
  }

  const id = Number(requestId)
  const leaveRequest = await database.collection('leave_requests').findOne({ id })
  if (!leaveRequest) throw new HttpError(404, 'Leave request not found.')
  if (user.role === 'department-admin' && leaveRequest.departmentId !== user.departmentId) {
    throw new HttpError(403, 'You can only review requests from your department.')
  }
  if (leaveRequest.status !== 'Pending') throw new HttpError(409, 'This leave request has already been reviewed.')

  await database.collection('leave_requests').updateOne({ id, status: 'Pending' }, {
    $set: { status, reviewedBy: user.name, reviewedAt: new Date() },
  })
  await writeAudit(database, {
    actorId: user.id,
    actorName: user.name,
    action: `${status.toLowerCase()} faculty leave request`,
    target: `${leaveRequest.facultyName} · ${leaveRequest.leaveType}`,
    details: leaveRequest.reason,
  })
  return database.collection('leave_requests').findOne({ id })
}
