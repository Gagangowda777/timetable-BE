import { createApp } from './app.js'
import { closeDatabase, connectDatabase } from './config/database.js'

const port = Number(process.env.PORT) || 4000
const database = await connectDatabase()
const app = createApp({ database })
const server = app.listen(port, () => console.log(`Timetable API listening on http://localhost:${port}`))

function shutdown() {
  server.close(async () => {
    await closeDatabase()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)