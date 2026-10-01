import { byId } from './dataHelpers.js'

async function populateUser(database, user, includePassword = false) {
  if (!user) return undefined
  const [department, campus, program] = await Promise.all([
    user.departmentId == null ? null : database.collection('departments').findOne(byId(user.departmentId)),
    user.campusId == null ? null : database.collection('campuses').findOne(byId(user.campusId)),
    user.programId == null ? null : database.collection('programs').findOne(byId(user.programId)),
  ])
  const result = {
    id: user.id, name: user.name, email: user.email, role: user.role,
    departmentId: user.departmentId, department: department?.name ?? null,
    campusId: user.campusId, campus: campus?.name ?? null,
    programId: user.programId, program: program?.name ?? null,
    cohort: user.cohort, availabilityDays: user.availabilityDays,
    available: user.available, status: user.status,
  }
  if (includePassword) result.passwordHash = user.passwordHash
  return result
}

function emailFilter(email) {
  return { email: email.trim().toLowerCase() }
}

export async function findUserById(database, id) {
  return populateUser(database, await database.collection('users').findOne(byId(id)))
}

export async function findUserWithPassword(database, email) {
  return populateUser(database, await database.collection('users').findOne(emailFilter(email)), true)
}