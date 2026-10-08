import { HttpError } from '../utils/httpError.js'
import { writeAudit } from './auditModel.js'
import { insertRecord } from './dataHelpers.js'

export const REQUEST_FORMS = ['change', 'leave']
export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'time', 'email', 'select', 'checkbox']
export const REQUEST_FORM_COLLECTION = 'request_form_fields'

const MAX_FIELDS_PER_FORM = 15
const MAX_OPTIONS = 15

// Fields the request endpoints understand natively. Only `scheduleId` is locked:
// a change request cannot be recorded without the class it applies to. Everything
// else — including the built-in fields — can be renamed, re-typed where sensible,
// made optional, or removed by a super admin.
const BUILT_IN_FIELDS = {
  change: [
    { key: 'scheduleId', label: 'Assigned class or lab', type: 'class', required: true, locked: true, placeholder: '' },
    { key: 'proposedChange', label: 'Requested change', type: 'textarea', required: true, placeholder: 'Describe the timetable change you need', maxLength: 1000 },
    { key: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Explain why this change is needed', maxLength: 1000 },
  ],
  leave: [
    { key: 'leaveType', label: 'Leave type', type: 'select', required: true, options: ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Other'] },
    { key: 'startDate', label: 'From date', type: 'date', required: true, placeholder: '' },
    { key: 'endDate', label: 'To date', type: 'date', required: true, placeholder: '' },
    { key: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'Explain why you need this leave', maxLength: 1000 },
  ],
}

const BUILT_IN_KEYS = new Set(Object.values(BUILT_IN_FIELDS).flat().map((field) => field.key))

function requireForm(value) {
  if (!REQUEST_FORMS.includes(value)) throw new HttpError(400, 'Choose the request change or request leave form.')
  return value
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`)
  return value.trim()
}

function requireFieldType(value) {
  if (!FIELD_TYPES.includes(value)) throw new HttpError(400, `Choose a field type from: ${FIELD_TYPES.join(', ')}.`)
  return value
}

function normalizeOptions(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback
  const options = [...new Set(source.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))]
  if (!options.length) throw new HttpError(400, 'Add at least one choice for a dropdown field.')
  if (options.length > MAX_OPTIONS) throw new HttpError(400, `Dropdown fields can hold at most ${MAX_OPTIONS} choices.`)
  if (options.some((option) => option.length > 60)) throw new HttpError(400, 'Dropdown choices must be 60 characters or fewer.')
  return options
}

function fieldKeyFromLabel(label) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
  return `custom_${slug || 'field'}`
}

function makeUniqueKey(label, usedKeys, existing) {
  const base = fieldKeyFromLabel(label)
  const isTaken = (key) => usedKeys.has(key) || BUILT_IN_KEYS.has(key) || existing.some((field) => field.key === key)
  let key = base
  let suffix = 2
  while (isTaken(key)) {
    key = `${base}_${suffix}`
    suffix += 1
  }
  return key
}

function fieldDocument(field, form, order) {
  return {
    form,
    key: field.key,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    placeholder: field.placeholder || '',
    options: field.options || [],
    maxLength: field.maxLength || null,
    locked: Boolean(field.locked),
    order,
    status: 'Active',
  }
}

async function listFormFields(database, form, filter = {}) {
  return database.collection(REQUEST_FORM_COLLECTION)
    .find({ form, ...filter })
    .sort({ order: 1, id: 1 })
    .toArray()
}

export async function ensureRequestFormFields(database) {
  for (const form of REQUEST_FORMS) {
    if (await database.collection(REQUEST_FORM_COLLECTION).countDocuments({ form })) continue
    for (const [order, field] of BUILT_IN_FIELDS[form].entries()) {
      await insertRecord(database, REQUEST_FORM_COLLECTION, fieldDocument(field, form, order))
    }
  }
}

function adminField(field) {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    placeholder: field.placeholder || '',
    options: field.options || [],
    maxLength: field.maxLength ?? null,
    locked: Boolean(field.locked),
    builtIn: BUILT_IN_KEYS.has(field.key),
    order: field.order ?? 0,
  }
}

function facultyField(field) {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    placeholder: field.placeholder || '',
    options: field.options || [],
    maxLength: field.maxLength ?? null,
  }
}

export async function listRequestFormFields(database) {
  const fields = await database.collection(REQUEST_FORM_COLLECTION).find().toArray()
  return Object.fromEntries(REQUEST_FORMS.map((form) => [form, fields
    .filter((field) => field.form === form)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id - right.id)
    .map(adminField)]))
}

export async function getFacultyRequestFormFields(database) {
  const [change, leave] = await Promise.all(REQUEST_FORMS.map(async (form) => {
    const fields = await listFormFields(database, form, { status: 'Active' })
    return fields.map(facultyField)
  }))
  return { change, leave }
}

export async function getRequestFormConfig(database, form) {
  const fields = await listFormFields(database, form, { status: 'Active' })
  return {
    fields,
    byKey: new Map(fields.map((field) => [field.key, field])),
    // No configuration at all (older database, or the feature switched off):
    // keep the original built-in validation rules untouched.
    isLegacy: fields.length === 0,
  }
}

export function collectCustomValues(config, input = {}) {
  const values = []
  for (const field of config.fields) {
    if (BUILT_IN_KEYS.has(field.key)) continue
    const raw = input[field.key]
    if (raw === undefined || raw === null || raw === '' || raw === false) {
      if (field.required) throw new HttpError(400, `${field.label} is required.`)
      continue
    }
    const value = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw).trim()
    if (value.length > 1000) throw new HttpError(400, `${field.label} must be 1000 characters or fewer.`)
    if (value) values.push({ key: field.key, label: field.label, value })
  }
  return values
}

export async function saveRequestFormFields(database, user, input = {}) {
  const form = requireForm(input.form)
  const existing = await database.collection(REQUEST_FORM_COLLECTION).find({ form }).toArray()
  const restoreDefaults = Boolean(input.restoreDefaults)
  const incoming = restoreDefaults
    ? BUILT_IN_FIELDS[form].map((field) => ({ ...field }))
    : input.fields

  if (!Array.isArray(incoming)) throw new HttpError(400, 'Send the ordered list of fields for this form.')
  if (!incoming.length) throw new HttpError(400, 'Keep at least one field on this form.')
  if (incoming.length > MAX_FIELDS_PER_FORM) throw new HttpError(400, `A request form can hold at most ${MAX_FIELDS_PER_FORM} fields.`)

  const existingById = new Map(existing.map((field) => [field.id, field]))
  const defaultsByKey = new Map(BUILT_IN_FIELDS[form].map((field) => [field.key, field]))
  const usedKeys = new Set()
  const documents = []

  for (const [order, raw] of incoming.entries()) {
    const requestedId = restoreDefaults ? null : raw?.id
    const current = requestedId === undefined || requestedId === null
      ? undefined
      : existingById.get(Number(requestedId))
    if (requestedId !== undefined && requestedId !== null && !current) {
      throw new HttpError(400, 'One of the submitted fields no longer exists on this form.')
    }
    const defaultField = current ? defaultsByKey.get(current.key) : defaultsByKey.get(raw?.key)
    const label = requireText(raw?.label ?? current?.label, 'Field label')
    if (label.length > 60) throw new HttpError(400, 'Field labels must be 60 characters or fewer.')
    // Existing fields keep their key; a brand new field reusing a built-in key
    // (restoring a default field) is honoured, everything else gets a generated key.
    const requestedKey = typeof raw?.key === 'string' ? raw.key : ''
    const key = current?.key || (BUILT_IN_KEYS.has(requestedKey) ? requestedKey : makeUniqueKey(label, usedKeys, existing))
    usedKeys.add(key)
    const type = defaultField ? defaultField.type : requireFieldType(raw?.type ?? current?.type)
    const options = type === 'select' ? normalizeOptions(raw?.options ?? current?.options, defaultField?.options) : []
    const placeholderSource = raw?.placeholder ?? current?.placeholder ?? defaultField?.placeholder ?? ''
    documents.push({
      id: current?.id ?? null,
      form,
      key,
      type,
      label,
      options,
      placeholder: typeof placeholderSource === 'string' ? placeholderSource.trim().slice(0, 120) : '',
      required: Boolean(defaultField?.locked) || Boolean(raw?.required ?? current?.required ?? defaultField?.required),
      locked: Boolean(defaultField?.locked || current?.locked),
      maxLength: defaultField?.maxLength ?? null,
      order,
      status: 'Active',
    })
  }

  for (const field of existing) {
    if (field.locked && !documents.some((document) => document.key === field.key)) {
      throw new HttpError(400, `${field.label} is required by the system and cannot be removed.`)
    }
  }

  const keptIds = new Set(documents.map((document) => document.id).filter(Boolean))
  const removed = existing.filter((field) => !keptIds.has(field.id))
  if (removed.length) {
    await database.collection(REQUEST_FORM_COLLECTION).deleteMany({ id: { $in: removed.map((field) => field.id) } })
  }

  for (const document of documents) {
    const { id, ...values } = document
    if (id) await database.collection(REQUEST_FORM_COLLECTION).updateOne({ id }, { $set: values })
    else await insertRecord(database, REQUEST_FORM_COLLECTION, values)
  }

  await writeAudit(database, {
    actorId: user.id,
    actorName: user.name,
    action: `Updated ${form === 'change' ? 'request change' : 'request leave'} form fields`,
    target: form === 'change' ? 'Request change form' : 'Request leave form',
    details: `${documents.length} input field(s) published`,
  })
  return listRequestFormFields(database)
}
