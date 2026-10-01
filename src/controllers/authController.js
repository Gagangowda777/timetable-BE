import { findUserWithPassword } from '../models/userModel.js'
import { verifyPassword } from '../utils/passwords.js'
import { createToken } from '../utils/tokens.js'

export async function login(request, response) {
  const email = typeof request.body.email === 'string' ? request.body.email.trim() : ''
  const password = typeof request.body.password === 'string' ? request.body.password : ''
  if (!email || !password) return response.status(400).json({ error: 'Email and password are required.' })

  const user = await findUserWithPassword(request.app.locals.database, email)
  if (!user || user.status !== 'Active' || !verifyPassword(password, user.passwordHash)) {
    return response.status(401).json({ error: 'Email or password is incorrect.' })
  }

  const { passwordHash, status, availabilityDays, available, ...publicUser } = user
  const token = createToken(publicUser, request.app.locals.tokenSecret)
  response.json({ token, user: publicUser })
}

export function currentUser(request, response) {
  response.json({ user: request.user })
}