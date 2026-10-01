import { insertRecord } from './dataHelpers.js'

export async function writeAudit(database, { actorId = null, actorName, action, target, details = '' }) {
  await insertRecord(database, 'audit_logs', { actorId, actorName, action, target, details })
}

export async function listAudit(database, limit = 200) {
  const records = await database.collection('audit_logs').find().sort({ id: -1 }).limit(limit).toArray()
  return records.map(({ id, actorName, action, target, details, createdAt }) => ({
    id, actor: actorName, action, target, details,
    createdAt: createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    time: createdAt.toISOString().slice(11, 16),
  }))
}