import teamPlanningRouter from './schedule/planning/team-planning-routes.ts'
import express from 'express'
import { ZodError } from 'zod'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { prisma, databasePool } from './db.ts'
import authRouter, { requireAuth } from './auth.ts'
import { selectLocation } from './organizations/location-context.ts'
import accessRouter from './organizations/access/access-routes.ts'
import organizationRouter from './organizations/routes.ts'
import profileRouter from './profile/routes.ts'
import scheduleRouter from './schedule/routes.ts'
import reportRouter from './schedule/reports/report-routes.ts'
import storageRouter from './storage/routes.ts'
import requestsRouter from './requests/routes.ts'
import documentsRouter from './documents/routes.ts'
import eventsRouter from './events/routes.ts'
import { MAX_DOCUMENT_BYTES, documentMimeTypes } from './documents/file-validation.ts'
import { appUrl } from './mail/transport.ts'
import { ApiError, isDatabaseBusy, isTransactionConflict } from './api-error.ts'
import { startWorkers } from './workers.ts'
import { admissionControl } from './security/admission.ts'
import { createLiveHub } from './live/hub.ts'
import { positiveInteger } from './runtime.ts'
import { readCache } from './read-cache.ts'
import { createHttpMetrics } from './metrics.ts'
import { requestReads } from './request-read-context.ts'
import { warmReadPaths } from './warmup.ts'
import { checkDatabasePolicy } from './database-policy.ts'
import { drainHttpServer } from './http-drain.ts'

if (process.env.NODE_ENV === 'production') await checkDatabasePolicy(databasePool)

const app = express()
app.disable('x-powered-by')
const metrics = createHttpMetrics()
app.use(metrics.middleware)
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== 'false') {
  if (['true', '1', '2', '*'].includes(process.env.TRUST_PROXY)) throw new Error('TRUST_PROXY must list explicit trusted IPs/subnets, never all clients or a hop count')
  app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean))
}
app.use(admissionControl())
app.use((request, _response, next) => {
  if (request.method === 'GET' || request.method === 'HEAD') requestReads.run(new Map(), next)
  else next()
})
app.use(helmet({ contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'", 'blob:'] } } }))
app.use('/api/organizations/:organizationId/shifts/batch', express.json({ limit: '64kb' }))
app.use('/api/organizations/:organizationId/documents/:documentId/assign', express.json({ limit: '64kb' }))
app.use('/api/organizations/:organizationId/events', express.json({ limit: '64kb' }))
app.use('/api/organizations/:organizationId/statistics/reports', express.json({ limit: '128kb' }))
app.use('/api/organizations/:organizationId/schedule', express.json({ limit: '192kb' }))
app.use('/api/organizations/:organizationId/requests',express.json({limit:'96kb'}))
app.use('/api/organizations/:organizationId/request-types',express.json({limit:'64kb'}))
app.use('/api/organizations/:organizationId/vacation-campaigns',express.json({limit:'64kb'}))
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
    const imageUpload = request.method === 'PUT' && (/^\/profile\/avatar(?:\/stage)?$/.test(request.path) || /^\/organizations\/[0-9a-f-]+\/logo(?:\/stage)?$/.test(request.path))
    const requestAttachment = request.method === 'PUT' && /^\/organizations\/[0-9a-f-]+\/requests\/[0-9a-f-]+\/attachments$/.test(request.path)
    const documentUpload = request.method === 'PUT' && /^\/organizations\/[0-9a-f-]+\/documents$/.test(request.path)
    const acceptedDocument = documentUpload && Boolean(request.is(Object.values(documentMimeTypes)))
    const acceptedImage = imageUpload && Boolean(request.is(['image/jpeg', 'image/png', 'image/webp']))
    const acceptedAttachment = requestAttachment && Boolean(request.is(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']))
    if (hasBody && !request.is('application/json') && !acceptedImage && !acceptedAttachment && !acceptedDocument) {
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

const live = createLiveHub()
let warmed = process.env.API_WARMUP !== 'true'
const warming = warmed ? Promise.resolve() : warmReadPaths().then(() => { warmed = true }).catch(error => {
  console.error('API warm-up failed:', error instanceof Error ? error.name : 'Error')
  process.exitCode = 1; void shutdown()
})
app.get('/internal/metrics', metrics.handler(live.size))
app.get('/api/live', requireAuth, live.handler)
app.get('/health/live', (_request, response) => response.json({ ok: true }))
let readiness: { until: number; pending: Promise<boolean> } | undefined
app.get('/health/ready', async (_request, response) => {
  if (!readiness || readiness.until <= Date.now()) readiness = { until: Date.now() + 1000,
    pending: prisma.$queryRaw`SELECT 1`.then(() => true, () => false) }
  const ok = !shuttingDown && warmed && live.connected() && await readiness.pending
  response.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ ok })
})
app.use('/api/organizations/:organizationId', (request, response, next) => {
  if (!['GET', 'HEAD'].includes(request.method)) response.once('finish', () => { if (response.statusCode < 400) readCache.invalidate(String(request.params.organizationId)) })
  next()
}, requireAuth, selectLocation)
app.use('/api', (_q,s,next)=>{s.set('Cache-Control','no-store');next()}, accessRouter)
app.use('/api', storageRouter)
app.use('/api/auth', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, authRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, profileRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, organizationRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, scheduleRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, reportRouter)
app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() }, requestsRouter)
app.use('/api', documentsRouter)
app.use('/api', eventsRouter)
app.use('/api', teamPlanningRouter)
app.use('/api', (_request, response) => response.status(404).json({ code: 'API_NOT_FOUND', message: 'Запрошенный адрес не найден.' }))
app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (response.headersSent || response.destroyed) { response.destroy(); return }
  if (error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'request.aborted', 'request.size.invalid'].includes(String(error.type))) {
    response.status(400).json({ code: 'INVALID_BODY', message: 'Некорректное тело запроса.' }); return
  }
  if (isDatabaseBusy(error)) {
    response.set('Retry-After', '2').status(503).json({ code: 'DATABASE_BUSY', message: 'Сервис занят. Повторите попытку немного позже.' }); return
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    if (/\/organizations\/[0-9a-f-]+\/schedule\//.test(request.path)) { response.status(413).json({code:'PLANNING_BODY_TOO_LARGE',message:'Данные планирования превышают допустимый размер.'}); return }
    if (/\/organizations\/[0-9a-f-]+\/events(?:\/|$)/.test(request.path)) { response.status(413).json({ code: 'EVENT_BODY_TOO_LARGE', message: 'Данные события превышают допустимый размер.' }); return }
    if (/\/organizations\/[0-9a-f-]+\/documents$/.test(request.path)) { response.status(413).json({ code: 'DOCUMENT_TOO_LARGE', message: `Файл должен весить не больше ${Math.ceil(MAX_DOCUMENT_BYTES / 1024 / 1024)} МБ.` }); return }
    const attachment = /\/requests\/[0-9a-f-]+\/attachments$/.test(request.path)
    response.status(413).json({ code: attachment ? 'ATTACHMENT_TOO_LARGE' : 'IMAGE_TOO_LARGE', message: attachment ? 'Файл должен весить не больше 10 МБ.' : 'Изображение должно весить не больше 8 МБ.' })
    return
  }
  if (error instanceof ZodError) { response.status(400).json({code:'VALIDATION_ERROR',message:error.issues[0]?.message ?? 'Проверьте данные.'}); return }
  if (error instanceof ApiError) {
    response.status(error.status).json({ code: error.code, message: error.message, ...(error.details ? { errors: error.details } : {}) })
    return
  }
  if (isTransactionConflict(error)) {
    response.status(409).json({ code: 'CONCURRENT_UPDATE', message: 'Данные уже изменились. Повторите запрос.' })
    return
  }
  console.error('API error:', error)
  response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' })
})

const port = Number(process.env.PORT || 3001)
const stopWorkers = process.env.RUN_BACKGROUND_WORKERS === 'false' ? async () => {} : startWorkers()
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Staffly API: http://localhost:${port}`))
server.headersTimeout = 15000
server.requestTimeout = positiveInteger('HTTP_REQUEST_TIMEOUT_MS', 60000, 300000)
server.keepAliveTimeout = 5000
server.maxRequestsPerSocket = 1000
server.maxConnections = positiveInteger('HTTP_MAX_CONNECTIONS', 20000, 100000)

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  // tsx watch allows five seconds; production drains admitted work for 30 seconds.
  const timeout = positiveInteger('HTTP_SHUTDOWN_TIMEOUT_MS', process.env.NODE_ENV === 'production' ? 30000 : 4000, 120000)
  const deadline = setTimeout(() => { console.error('API drain deadline exceeded'); server.closeAllConnections(); process.exit(1) }, timeout)
  deadline.unref()
  try {
    const closed = drainHttpServer(server)
    await Promise.all([closed, live.stop(), stopWorkers(), warming])
    await prisma.$disconnect()
    clearTimeout(deadline)
  } catch (error) {
    console.error('API shutdown failed:', error)
    process.exitCode = 1
  }
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })
