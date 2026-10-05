import { HttpError } from '../utils/httpError.js'
import { writeAudit } from './auditModel.js'
import { insertRecord } from './dataHelpers.js'

export const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Other']

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function normalizeDate(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!DATE_PATTERN.test(text)) return null
  const parsed = new Date(`${text}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : text
}

export async function createFacultyLeaveRequest(database, user, input) {
  const leaveType = typeof input.leaveType === 'string' ? input.leaveType.trim() : ''
  const startDate = normalizeDate(input.startDate)
  const endDate = normalizeDate(input.endDate)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''

  if (!LEAVE_TYPES.includes(leaveType)) throw new HttpError(400, 'Choose a valid leave type.')
  if (!startDate || !endDate) throw new HttpError(400, 'Choose a valid start and end date.')
  if (endDate < startDate) throw new HttpError(400, 'The end date cannot be before the start date.')
  if (!reason) throw new HttpError(400, 'Describe the reason for your leave.')
  if (reason.length > 1000) throw new HttpError(400, 'The reason must be 1000 characters or fewer.')

  const numberOfDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1

  const id = await insertRecord(database, 'leave_requests', {
    facultyId: user.id,
    facultyName: user.name,
    departmentId: user.departmentId ?? null,
    leaveType,
    startDate,
    endDate,
    numberOfDays,
    reason,
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
