import { createHmac, timingSafeEqual } from 'node:crypto'

const TOKEN_LIFETIME_SECONDS = 60 * 60 * 8

function signature(encodedPayload, secret) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export function createToken(user, secret) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
  })).toString('base64url')

  return `${payload}.${signature(payload, secret)}`
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null
  const [payload, suppliedSignature] = token.split('.')
  if (!payload || !suppliedSignature) return null

  const expectedSignature = Buffer.from(signature(payload, secret))
  const actualSignature = Buffer.from(suppliedSignature)
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!decoded.sub || !decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000)) return null
    return decoded
  } catch {
    return null
  }
}