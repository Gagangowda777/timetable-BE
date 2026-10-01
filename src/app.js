import express from 'express'
import adminRoutes from './routes/adminRoutes.js'
import authRoutes from './routes/authRoutes.js'
import dashboardRoutes from './routes/dashboardRoutes.js'
import systemRoutes from './routes/systemRoutes.js'

export function createApp({ database, tokenSecret = process.env.AUTH_TOKEN_SECRET } = {}) {
  if (process.env.NODE_ENV === 'production' && !tokenSecret) {
    throw new Error('AUTH_TOKEN_SECRET must be set in production.')
  }
  if (!database) throw new Error('A connected MongoDB database must be provided.')

  const app = express()
  app.disable('x-powered-by')
  app.locals.database = database
  app.locals.tokenSecret = tokenSecret || 'development-only-secret-change-before-deploying'
  app.use(express.json({ limit: '256kb' }))
  app.use((request, response, next) => {
    const rawOrigins = process.env.WEB_ORIGIN || '*'
    const allowedOrigins = rawOrigins.split(',').map((o) => o.trim().replace(/\/$/, ''))
    const origin = request.get('origin')

    if (origin) {
      const cleanOrigin = origin.replace(/\/$/, '')
      const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(cleanOrigin) || allowedOrigins.includes(origin)
      response.set('Access-Control-Allow-Origin', isAllowed ? origin : (allowedOrigins[0] || '*'))
      response.set('Vary', 'Origin')
      response.set('Access-Control-Allow-Credentials', 'true')
      response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With')
      response.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    } else {
      response.set('Access-Control-Allow-Origin', '*')
    }

    if (request.method === 'OPTIONS') {
      return response.sendStatus(204)
    }
    next()
  })

  app.get('/api/health', (request, response) => response.json({ status: 'ok' }))
  app.use('/api/auth', authRoutes)
  app.use('/api/dashboard', dashboardRoutes)
  app.use('/api/admin', adminRoutes)
  app.use('/api/system', systemRoutes)
  app.use('/api', (request, response) => response.status(404).json({ error: 'API endpoint not found.' }))

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error)
    const isConstraintError = error.code === 11000
    if (error.status >= 500 || (!error.status && !isConstraintError)) console.error(error)
    const status = error.status || (isConstraintError ? 409 : 500)
    const message = error.status ? error.message : isConstraintError ? 'A record with the same unique value already exists.' : 'An unexpected server error occurred.'
    response.status(status).json({ error: message, ...(error.details || {}) })
  })

  return app
}