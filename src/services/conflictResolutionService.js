import { HttpError } from '../utils/httpError.js'
import { writeAudit } from '../models/auditModel.js'
import { byId } from '../models/dataHelpers.js'
import { validateTimetableEntry } from '../utils/timetableConflictService.js'

const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function timeMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number)
  return hours * 60 + minutes
}

function isRoomConflict(conflict) {
  return /room|overlap/i.test(`${conflict.type || ''} ${conflict.detail || ''}`)
}

function involvedNameList(conflict) {
  return String(conflict.schedules || '').split('·').map((part) => part.trim()).filter(Boolean)
}

async function othersInOriginalRoom(database, schedule) {
  return database.collection('schedules').countDocuments({
    day: schedule.day, roomId: schedule.roomId, status: { $ne: 'Archived' },
    start: { $lt: schedule.end }, end: { $gt: schedule.start }, id: { $ne: schedule.id },
  })
}

// Collects candidate fixes (different room, different class slot, or different faculty),
// keeping only options that pass the shared timetable validator and actually clear the clash.
async function collectFixOptions(database, conflict, targets) {
  const [rooms, classSlots, workingDays] = await Promise.all([
    database.collection('rooms').find({ status: 'Active' }).sort({ name: 1 }).toArray(),
    database.collection('time_slots').find({ type: 'CLASS', status: 'Active' }).toArray(),
    database.collection('working_days').find({ enabled: true }).sort({ order: 1 }).toArray(),
  ])
  const enabledDays = new Set(workingDays.map((item) => item.day))
  const options = []
  const seen = new Set()

  async function consider(schedule, patch, action, message) {
    const key = `${schedule.id}:${action}:${JSON.stringify(patch)}`
    if (seen.has(key)) return
    seen.add(key)
    const candidate = { ...schedule, ...patch }
    // Drop the pre-fetched room so the validator re-reads it from (possibly patched) roomId.
    delete candidate.room
    const result = await validateTimetableEntry(database, candidate, { excludeEntryId: schedule.id })
    if (result.conflict) return
    if (isRoomConflict(conflict) && (await othersInOriginalRoom(database, schedule)) > 1) return
    options.push({ scheduleId: schedule.id, patch, action, message })
  }

  for (const schedule of targets) {
    const original = `${schedule.day} ${schedule.start}–${schedule.end}`
    const originalRoomName = schedule.room?.name || `room #${schedule.roomId}`

    const roomChoices = rooms
      .filter((room) => room.id !== schedule.roomId)
      .sort((left, right) => Number(right.campusId != null && right.campusId === schedule.campusId)
        - Number(left.campusId != null && left.campusId === schedule.campusId))
    for (const room of roomChoices) {
      await consider(
        schedule,
        { roomId: room.id },
        'room',
        `Moved ${schedule.subject} to ${room.name} (${original}) instead of ${originalRoomName}.`,
      )
    }

    const duration = timeMinutes(schedule.end) - timeMinutes(schedule.start)
    const slotChoices = classSlots
      .filter((slot) => enabledDays.has(slot.day) && !(slot.day === schedule.day && slot.start === schedule.start && slot.end === schedule.end))
      .sort((left, right) => (left.day === schedule.day ? 0 : 1) - (right.day === schedule.day ? 0 : 1)
        || Number(timeMinutes(right.end) - timeMinutes(right.start) === duration)
          - Number(timeMinutes(left.end) - timeMinutes(left.start) === duration)
        || dayOrder.indexOf(left.day) - dayOrder.indexOf(right.day)
        || left.start.localeCompare(right.start))
    for (const slot of slotChoices) {
      const patch = { day: slot.day, start: slot.start, end: slot.end }
      if (schedule.timeSlotId != null || schedule.entrySource === 'manual') patch.timeSlotId = slot.id
      await consider(
        schedule,
        patch,
        'time',
        `Moved ${schedule.subject} from ${original} to ${slot.day} ${slot.start}–${slot.end}.`,
      )
    }

    const facultyList = schedule.departmentId
      ? await database.collection('users').find({ role: 'faculty', status: 'Active', departmentId: schedule.departmentId }).sort({ name: 1 }).toArray()
      : []
    for (const facultyMember of facultyList) {
      if (facultyMember.id === schedule.facultyId) continue
      await consider(
        schedule,
        { facultyId: facultyMember.id },
        'faculty',
        `Reassigned ${schedule.subject} (${original}) to ${facultyMember.name}.`,
      )
    }
  }
  return options
}

// Optional AI assist: when AI_API_KEY is set, an OpenAI-compatible model ranks the
// already-validated fixes. It can only choose among options our validator approved, and a
// missing or failed AI call falls back to the first valid fix.
async function rankOptionsWithAI(conflict, options) {
  const apiKey = process.env.AI_API_KEY
  if (!apiKey || options.length < 2) return null
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = process.env.AI_MODEL || 'gpt-4o-mini'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You assist university timetable coordinators. Reply only with JSON {"index": number, "rationale": string}.' },
          {
            role: 'user',
            content: `Conflict: ${conflict.type} on ${conflict.day} ${conflict.start}–${conflict.end} (${conflict.detail || ''})\n`
              + `Validated fix options:\n${options.map((option, index) => `${index}: ${option.message}`).join('\n')}\n`
              + 'Pick the index (0-based) of the best fix for minimal disruption and give a rationale of at most 15 words.',
          },
        ],
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}')
    const index = Number(parsed.index)
    if (!Number.isInteger(index) || index < 0 || index >= options.length) return null
    return { index, rationale: String(parsed.rationale || '').slice(0, 160) }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveScheduleConflict(database, user, conflictId) {
  const conflict = await database.collection('conflicts').findOne(byId(conflictId))
  if (!conflict) throw new HttpError(404, 'Conflict not found.')
  if (user.role === 'department-admin' && (conflict.isCrossDepartment || conflict.departmentId !== user.departmentId)) {
    throw new HttpError(403, 'Cross-department conflicts must be resolved by an Academic Admin.')
  }
  if (conflict.status !== 'Open') {
    return { id: conflict.id, status: conflict.status, autoFixed: false, message: 'This conflict is already resolved.' }
  }

  let message = ''
  let autoFixed = false
  let action = 'verified'

  const names = involvedNameList(conflict)
  const scope = conflict.isCrossDepartment
    ? (conflict.departmentId ? { departmentId: conflict.departmentId } : {})
    : { departmentId: conflict.departmentId }
  const overlapping = await database.collection('schedules').find({
    ...scope, day: conflict.day, status: { $ne: 'Archived' },
    start: { $lt: conflict.end }, end: { $gt: conflict.start },
  }).sort({ id: 1 }).toArray()
  const named = names.length ? overlapping.filter((item) => names.includes(item.subject)) : []
  const targets = named.length ? named : overlapping

  if (targets.length) {
    const checks = await Promise.all(targets.map(async (schedule) => {
      const result = await validateTimetableEntry(database, schedule, { excludeEntryId: schedule.id })
      return !result.conflict
    }))
    if (!checks.every(Boolean)) {
      const departmentIds = [...new Set(targets.map((item) => item.departmentId).filter((id) => id != null))]
      const departments = await database.collection('departments').find({ id: { $in: departmentIds } }).toArray()
      const campusByDepartment = new Map(departments.map((item) => [item.id, item.campusId]))
      const roomIds = targets.map((item) => item.roomId).filter((id) => id != null)
      const rooms = roomIds.length ? await database.collection('rooms').find({ id: { $in: roomIds } }).toArray() : []
      const roomsById = new Map(rooms.map((item) => [item.id, item]))
      const enriched = targets.map((item) => ({
        ...item,
        room: roomsById.get(item.roomId) || null,
        campusId: campusByDepartment.get(item.departmentId) ?? null,
      }))

      const options = await collectFixOptions(database, conflict, enriched)
      if (!options.length) {
        throw new HttpError(409, 'No safe automatic fix was found for this conflict. Adjust the affected class manually, then resolve it.')
      }
      const pick = await rankOptionsWithAI(conflict, options)
      const chosen = options[pick?.index] || options[0]
      await database.collection('schedules').updateOne(byId(chosen.scheduleId), { $set: chosen.patch })
      message = chosen.message + (pick ? ` AI assist: ${pick.rationale}` : '')
      autoFixed = true
      action = chosen.action
    }
  }

  if (!message) {
    message = `No clashing classes remain for ${conflict.type.toLowerCase()} on ${conflict.day} ${conflict.start}–${conflict.end}; marked as resolved.`
  }

  await database.collection('conflicts').updateOne(
    { id: conflict.id, status: 'Open' },
    { $set: { status: 'Resolved', resolutionAction: action, resolutionNote: message } },
  )
  await writeAudit(database, {
    actorId: user.id, actorName: user.name,
    action: autoFixed ? 'Auto-resolved scheduling conflict' : 'Resolved scheduling conflict',
    target: conflict.type, details: message,
  })
  return { id: conflict.id, status: 'Resolved', autoFixed, action, message }
}
