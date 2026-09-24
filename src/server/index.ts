import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { prisma } from './db.ts'
import authRouter from './auth.ts'
import organizationRouter from './organizations/routes.ts'
import profileRouter from './profile/routes.ts'
import scheduleRouter from './schedule/routes.ts'
import storageRouter from './storage/routes.ts'
import requestsRouter from './requests/routes.ts'
import { appUrl } from './mail.ts'
import { ApiError } from './api-error.ts'
import { startStorageCleanup } from './storage/image-service.ts'

const app = express()
app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'", 'blob:'] } } }))
app.use(express.json({ limit: '16kb' }))
app.use(cookieParser())
app.use('/api', (request, response, next) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.get('origin')
    if ((origin && origin !== appUrl) || (!origin && request.get('cookie'))) {
      response.status(403).json({ message: 'Недопустимый источник запроса.' })
      return
    }
    const contentLength = Number(request.get('content-length') ?? 0)
    const hasBody = contentLength > 0 || Boolean(request.get('transfer-encoding'))
    const imageUpload = request.method === 'PUT' && (/^\/profile\/avatar$/.test(request.path) || /^\/organizations\/[0-9a-f-]+\/logo$/.test(request.path))
    const requestAttachment = request.method === 'PUT' && /^\/organizations\/[0-9a-f-]+\/requests\/[0-9a-f-]+\/attachments$/.test(request.path)
    const acceptedImage = imageUpload && Boolean(request.is(['image/jpeg', 'image/png', 'image/webp']))
    const acceptedAttachment = requestAttachment && Boolean(request.is(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']))
    if (hasBody && !request.is('application/json') && !acceptedImage && !acceptedAttachment) {
      response.status(415).json({ message: imageUpload ? 'Поддерживаются только JPEG, PNG и WebP.' : 'Требуется application/json.' })
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

app.use('/api', storageRouter)
app.use('/api/auth', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, authRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, profileRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, organizationRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, scheduleRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, requestsRouter)
app.use('/api', (_request, response) => response.status(404).json({ code: 'API_NOT_FOUND', message: 'Запрошенный адрес не найден.' }))
app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    const attachment = /\/requests\/[0-9a-f-]+\/attachments$/.test(request.path)
    response.status(413).json({ code: attachment ? 'ATTACHMENT_TOO_LARGE' : 'IMAGE_TOO_LARGE', message: attachment ? 'Файл должен весить не больше 10 МБ.' : 'Изображение должно весить не больше 8 МБ.' })
    return
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ code: error.code, message: error.message, ...(error.details ? { errors: error.details } : {}) })
    return
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
    response.status(409).json({ code: 'CONCURRENT_UPDATE', message: 'Данные уже изменились. Повторите запрос.' })
    return
  }
  console.error('API error:', error)
  response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' })
})

const port = Number(process.env.PORT || 3001)
const stopStorageCleanup = startStorageCleanup()
app.listen(port, () => console.log(`Staffly API: http://localhost:${port}`))

process.on('SIGTERM', () => { stopStorageCleanup(); void prisma.$disconnect() })
