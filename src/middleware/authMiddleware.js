import { findUserById } from '../models/userModel.js'
import { verifyToken } from '../utils/tokens.js'

export async function authenticate(request, response, next) {
  const authorization = request.get('authorization') || ''
  const [scheme, token] = authorization.split(' ')
  const claims = scheme === 'Bearer' ? verifyToken(token, request.app.locals.tokenSecret) : null
  if (!claims) return response.status(401).json({ error: 'Sign in to continue.' })

  const user = await findUserById(request.app.locals.database, claims.sub)
  if (!user || user.status !== 'Active' || user.role !== claims.role) {
    return response.status(401).json({ error: 'Your session is no longer valid. Sign in again.' })
  }

  request.user = user
  next()
}

export function authorize(...roles) {
  return (request, response, next) => {
    if (!roles.includes(request.user.role)) return response.status(403).json({ error: 'You do not have permission to access this resource.' })
    next()
  }
}