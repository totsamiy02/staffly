import { reserveOrganizationExport } from '../../resources/quotas.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { storage } from '../../storage/provider.ts'
import { reportAccess } from './report-service.ts'
import { reportBody } from './report-schemas.ts'
import type { ReportInput } from '../../../app/schedule/reports/reporting.ts'
import type { ReportExport, Prisma } from '../../../generated/prisma/client.ts'
import { startBackgroundTask } from '../../background-task.ts'
import { stageStoredFile, deletePendingFile } from '../../storage/image-service.ts'

const publicJob = (job: ReportExport) => ({ id: job.id, status: job.status,
  message: job.status === 'FAILED' ? job.errorCode === 'ORGANIZATION_STORAGE_QUOTA' ? 'Хранилище организации заполнено. Освободите место и повторите экспорт.' : 'Не удалось подготовить отчёт. Проверьте доступ и повторите попытку.' : undefined,
  statusUrl: `/organizations/${job.organizationId}/statistics/reports/exports/${job.id}` })
const converters = new Set<ChildProcess>()
const interrupted = new WeakSet<ChildProcess>()
export async function authorizeExport(userId: string, organizationId: string, input: ReportInput) {
  const { locations } = await reportAccess(userId, organizationId, prisma, 'reports.export')
  if (!locations.length || input.locationIds.some(id => !locations.some(location => location.id === id))) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Область отчёта больше недоступна.')
  return { ...input, locationIds: input.locationIds.length ? input.locationIds : locations.map(location => location.id) }
}
export async function enqueueExport(userId: string, organizationId: string, input: ReportInput) {
  const frozen = await authorizeExport(userId, organizationId, input)
  const inputHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex')
  return prisma.$transaction(async tx => {
    // Queue timestamps must agree with PostgreSQL's clock in any server timezone.
    // Keep UTC local to this transaction, as with the existing mail outbox.
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(781234567::bigint)::text`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 7))::text`
    const active = { userId, status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: new Date() } }
    const existing = await tx.reportExport.findFirst({ where: { ...active, organizationId, inputHash } })
    if (existing) return publicJob(existing)
    if (await tx.reportExport.count({ where: active }) >= 2) throw new ApiError(429, 'EXPORT_BUSY', 'Дождитесь подготовки предыдущих отчётов.')
    if (await tx.reportExport.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, expiresAt: { gt: new Date() } } }) >= 200) throw new ApiError(503, 'EXPORT_BUSY', 'Очередь отчётов занята. Повторите попытку позже.')
    await reserveOrganizationExport(tx, organizationId)
    return publicJob(await tx.reportExport.create({ data: { userId, organizationId, input: frozen as unknown as Prisma.InputJsonValue, inputHash, expiresAt: new Date(Date.now() + 3600000) } }))
  })
}
export async function getExport(userId: string, organizationId: string, id: string) {
  const job = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
    return tx.reportExport.findFirst({ where: { id, userId, organizationId, expiresAt: { gt: new Date() } } })
  })
  if (!job) throw new ApiError(404, 'EXPORT_NOT_FOUND', 'Отчёт не найден или срок хранения истёк.')
  await authorizeExport(userId, organizationId, reportBody.parse(job.input))
  return { job, public: publicJob(job) }
}

async function generate(job: ReportExport, directory: string) {
  const output = path.join(directory, 'report.xlsx')
  const child = spawn(process.execPath, ['--max-old-space-size=384', '--import', fileURLToPath(import.meta.resolve('tsx')),
    fileURLToPath(new URL('./export-child.ts', import.meta.url)), job.id, output], { cwd: process.cwd(),
    env: { PATH: process.env.PATH, TMPDIR: directory, NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET, DB_POOL_MAX: '2', STORAGE_DRIVER: 'local', LOCAL_STORAGE_ROOT: directory },
    stdio: ['ignore', 'ignore', 'pipe'] })
  converters.add(child)
  let diagnostic = ''
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-1000) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error(`Report subprocess failed (${code}): ${diagnostic}`), { code: interrupted.has(child) ? 'EXPORT_INTERRUPTED' : 'EXPORT_FAILED' })))
    })
    if ((await stat(output)).size > 50 * 1024 * 1024) throw new Error('Report exceeds output limit')
    return await readFile(output)
  } finally { clearTimeout(timer); converters.delete(child) }
}

export async function claimReportExport(token: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
    // Serialize only the short claim, not report generation. This enforces one
    // converter per tenant across every worker, including expired-lease recovery.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(781234567::bigint)::text`
    const rows = await tx.$queryRaw<Array<{ id: string; organizationId:string }>>`
      SELECT j.id, j.organization_id AS "organizationId" FROM report_exports j
      JOIN organization_resource_budgets b ON b.organization_id=j.organization_id
      WHERE j.expires_at>now() AND j.attempts<3
      AND (j.status='PENDING' OR j.status='RUNNING' AND j.lease_until<now())
      AND NOT EXISTS(SELECT 1 FROM report_exports active WHERE active.organization_id=j.organization_id AND active.id<>j.id AND active.status='RUNNING' AND active.lease_until>=now())
      ORDER BY b.last_export_at ASC NULLS FIRST,j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`
    if (!rows[0]) return null
    await tx.organizationResourceBudget.update({where:{organizationId:rows[0].organizationId},data:{lastExportAt:new Date()}})
    return tx.reportExport.update({where:{id:rows[0].id},data:{status:'RUNNING',attempts:{increment:1},leaseToken:token,leaseUntil:new Date(Date.now()+180000)}})
  })
}
export async function processReportExport() {
  const token = randomUUID()
  const claimed = await claimReportExport(token)
  if (!claimed) return false
  const directory = await mkdtemp(path.join(tmpdir(), 'staffly-export-'))
  let stagedId: string | undefined
  try {
    if (!await prisma.user.findFirst({ where: { id: claimed.userId, deletedAt: null }, select: { id: true } })) throw new Error('Inactive export user')
    const bytes = await generate(claimed, directory)
    await authorizeExport(claimed.userId, claimed.organizationId, reportBody.parse(claimed.input))
    const staged = await stageStoredFile({ objectKey: `exports/${claimed.organizationId}/${randomUUID()}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'DOCUMENT', uploadedByUserId: claimed.userId, organizationId: claimed.organizationId }, bytes)
    stagedId = staged.id
    // Keep the durable expiry record even after READY. A crash between object
    // upload and job binding cannot leave an untracked object in shared storage.
    const changed = await prisma.reportExport.updateMany({ where: { id: claimed.id, leaseToken: token, status: 'RUNNING' }, data: { status: 'READY', objectKey: staged.objectKey, leaseUntil: null } })
    if (!changed.count) await deletePendingFile(staged.id)
  } catch (error) {
    if (stagedId) await deletePendingFile(stagedId).catch(() => undefined)
    const retry = error && typeof error === 'object' && 'code' in error && error.code === 'EXPORT_INTERRUPTED' && claimed.attempts < 3
    await prisma.reportExport.updateMany({ where: { id: claimed.id, leaseToken: token }, data: { status: retry ? 'PENDING' : 'FAILED', leaseUntil: null, errorCode: retry ? null : error instanceof ApiError && error.code === 'ORGANIZATION_STORAGE_QUOTA' ? error.code : 'EXPORT_FAILED' } })
    console.error('Report export failed:', claimed.id, error instanceof ApiError ? error.code : 'EXPORT_FAILED')
  } finally { await rm(directory, { recursive: true, force: true }) }
  return true
}
export function startReportExports() {
  const stop = startBackgroundTask({ name: 'Report exports', intervalMs: 1000, run: async shouldContinue => {
    const expired = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`
      await tx.reportExport.updateMany({ where: { status: 'RUNNING', attempts: { gte: 3 }, leaseUntil: { lt: new Date() } }, data: { status: 'FAILED', errorCode: 'EXPORT_INTERRUPTED' } })
      return tx.reportExport.findMany({ where: { expiresAt: { lt: new Date() } }, take: 50 })
    })
    for (const job of expired) {
      if (job.objectKey) {
        const file = await prisma.storedFile.findUnique({ where: { objectKey: job.objectKey }, select: { id: true } })
        if (file) { if (!await deletePendingFile(file.id)) continue }
        else await storage.delete(job.objectKey)
      }
      await prisma.reportExport.deleteMany({ where: { id: job.id } })
    }
    while (shouldContinue() && await processReportExport()) { /* The worker has at most one converter at a time. */ }
  } })
  return async () => {
    const stopped = stop()
    for (const child of converters) { interrupted.add(child); child.kill('SIGTERM') }
    await stopped
  }
}
