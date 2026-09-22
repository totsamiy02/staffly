import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { prisma } from './db.ts'
import authRouter from './auth.ts'
import { appUrl } from './mail.ts'

const app = express()
app.disable('x-powered-by')
app.use(helmet())
app.use(express.json({ limit: '16kb' }))
app.use(cookieParser())
app.use('/api', (request, response, next) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.get('origin')
    if ((origin && origin !== appUrl) || (!origin && request.get('cookie'))) {
      response.status(403).json({ message: 'Недопустимый источник запроса.' })
      return
    }
    if (!request.is('application/json')) {
      response.status(415).json({ message: 'Требуется application/json.' })
      return
    }
  }
  next()
})

if (process.env.NODE_ENV !== 'production') app.get('/api/database-status', async (_request, response) => {
  try {
    const result = await prisma.$queryRaw<Array<{ database: string; server_time: Date }>>`SELECT current_database() AS database, now() AS server_time`
    response.json({ connected: true, ...result[0] })
  } catch (error) {
    console.error('Database connection failed:', error)
    response.status(503).json({ connected: false, message: 'Не удалось подключиться к базе данных' })
  }
})

app.use('/api/auth', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, authRouter)
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error('API error:', error)
  response.status(500).json({ message: 'Внутренняя ошибка сервера.' })
})

const port = Number(process.env.PORT || 3001)
app.listen(port, () => console.log(`Staffly API: http://localhost:${port}`))

process.on('SIGTERM', () => { void prisma.$disconnect() })
