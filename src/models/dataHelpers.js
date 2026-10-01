import { nextId } from '../config/database.js'

export const byId = (id) => ({ id: Number(id) })

export async function insertRecord(database, collectionName, document) {
  const id = await nextId(database, collectionName)
  await database.collection(collectionName).insertOne({ id, ...document, createdAt: new Date() })
  return id
}

export function sortByName(records) {
  return records.sort((left, right) => left.name.localeCompare(right.name))
}

export function sortByDayAndTime(records) {
  const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  return records.sort((left, right) => order.indexOf(left.day) - order.indexOf(right.day) || left.start.localeCompare(right.start))
}
