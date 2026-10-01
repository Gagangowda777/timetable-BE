import {
  createSystemEntity,
  deleteSystemEntity,
  getSystemAnalytics,
  getSystemAudit,
  getSystemEntity,
  getSystemOverview,
  getSystemSettings,
  listSystemEntities,
  saveSystemSettings,
  setSystemEntityStatus,
  updateSystemEntity,
} from '../models/systemModel.js'
import { createFaculty, deleteFaculty, getFaculty, getFacultyOptions, listFaculty, updateFaculty } from '../models/facultyModel.js'

function database(request) {
  return request.app.locals.database
}

export async function overview(request, response) {
  response.json(await getSystemOverview(database(request)))
}

export async function analytics(request, response) {
  response.json(await getSystemAnalytics(database(request)))
}

export async function audit(request, response) {
  response.json({ events: await getSystemAudit(database(request), request.query.limit) })
}

export async function settings(request, response) {
  response.json(await getSystemSettings(database(request)))
}

export async function updateSettings(request, response) {
  response.json(await saveSystemSettings(database(request), request.user, request.body))
}

export async function entityList(request, response) {
  response.json({ records: await listSystemEntities(database(request), request.params.entity) })
}

export async function entityCreate(request, response) {
  response.status(201).json({ record: await createSystemEntity(database(request), request.user, request.params.entity, request.body) })
}

export async function entityUpdate(request, response) {
  response.json({ record: await updateSystemEntity(database(request), request.user, request.params.entity, request.params.id, request.body) })
}

export async function entityStatus(request, response) {
  response.json({ record: await setSystemEntityStatus(database(request), request.user, request.params.entity, request.params.id, request.body.status) })
}

export async function entityDelete(request, response) {
  response.json(await deleteSystemEntity(database(request), request.user, request.params.entity, request.params.id))
}

export async function entityGet(request, response) {
  response.json({ record: await getSystemEntity(database(request), request.params.entity, request.params.id) })
}

export async function facultyList(request, response) {
  const databaseInstance = database(request)
  response.json({ records: await listFaculty(databaseInstance, request.query), options: await getFacultyOptions(databaseInstance) })
}

export async function facultyCreate(request, response) {
  response.status(201).json({ record: await createFaculty(database(request), request.user, request.body) })
}

export async function facultyGet(request, response) {
  response.json({ record: await getFaculty(database(request), request.params.id) })
}

export async function facultyUpdate(request, response) {
  response.json({ record: await updateFaculty(database(request), request.user, request.params.id, request.body) })
}

export async function facultyDelete(request, response) {
  response.json(await deleteFaculty(database(request), request.user, request.params.id))
}