import { replacementCandidates, assignReplacement } from './replacements.ts'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../../auth.ts'
import { accountRateLimit } from '../../security/rate-limit.ts'
import { availabilitySaveSchema, type AvailabilityWarning } from '../../../shared/availability.ts'
import { readAvailability, readAvailabilityHistory, saveAvailability, availabilityMembers } from './service.ts'
import { getMembership } from '../../organizations/access/permissions.ts'
import { requirePlanFeature } from '../../subscriptions/access.ts'
import { checkAvailabilityAssignments } from './checks.ts'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { activeTarget } from '../service.ts'
import { hasPermission } from '../../organizations/access/access.ts'

const router = Router()
const base = '/organizations/:organizationId/availability/:memberId'
const params = z.object({ organizationId: z.uuid(), memberId: z.uuid() })
const actor = (request: Request) => (request as AuthenticatedRequest).auth!.userId
const limit = accountRateLimit('availability-write', 30, 60000)
router.get('/organizations/:organizationId/availability-members', requireAuth, async (request, response) => {
  const organizationId = z.uuid().parse(request.params.organizationId)
  response.set('Cache-Control', 'private, no-store').json(await availabilityMembers(actor(request), organizationId))
})
router.use(base, requireAuth)
router.get(base, async (request, response) => {
  const ids = params.parse(request.params)
  response.set('Cache-Control', 'private, no-store').json(await readAvailability(actor(request), ids.organizationId, ids.memberId))
})
router.get(base + '/history', async (request, response) => {
  const ids = params.parse(request.params)
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(request.query)
  response.set('Cache-Control', 'private, no-store').json(await readAvailabilityHistory(actor(request), ids.organizationId, ids.memberId, page))
})
router.post(base, limit, async (request, response) => {
  const ids = params.parse(request.params)
  response.json(await saveAvailability(actor(request), ids.organizationId, ids.memberId, availabilitySaveSchema.parse(request.body)))
})
// The shift form can inspect only the target and point it may assign. This does
// not grant access to the employee's full organization-wide availability.
router.post(base + '/preview', async (request, response) => {
  const ids = params.parse(request.params)
  const body = z.object({ periods: z.array(z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).strict()).min(1).max(62) }).strict().parse(request.body)
  const result = await prisma.$transaction(async db => {
    const user = await getMembership(actor(request), ids.organizationId, db)
    if (!hasPermission(user, 'schedule.create') && !hasPermission(user, 'schedule.edit') && !hasPermission(user, 'drafts.edit')) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для проверки назначений.')
    }
    await requirePlanFeature(ids.organizationId, 'availability', db)
    for (const period of body.periods) {
      const start = new Date(period.start)
      const end = new Date(period.end)
      if (end <= start || +end - +start > 366 * 86400000) {
        throw new ApiError(400, 'SHIFT_RANGE', 'Проверьте период смены.')
      }
      await activeTarget(db, ids.organizationId, ids.memberId, start, end)
    }
    let warning: AvailabilityWarning | null = null
    try {
      await checkAvailabilityAssignments(db, user, body.periods.map(period => ({
        memberId: ids.memberId, locationId: user.locationId, start: new Date(period.start), end: new Date(period.end),
      })))
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'AVAILABILITY_WARNING') throw error
      warning = error.details as AvailabilityWarning
    }
    return { issues: warning?.availabilityConflicts ?? [], warning }
  }, { timeout: 15000 })
  response.set('Cache-Control', 'private, no-store').json(result)
})

const shiftBase = '/organizations/:organizationId/availability-shifts/:shiftId'
const shiftParams = z.object({ organizationId: z.uuid(), shiftId: z.uuid() })
router.get(shiftBase + '/candidates', requireAuth, async (request, response) => {
  const ids = shiftParams.parse(request.params)
  const query = z.object({ search: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(request.query)
  response.set('Cache-Control', 'private, no-store').json(await replacementCandidates(actor(request), ids.organizationId, ids.shiftId, query.search, query.page))
})
router.post(shiftBase, requireAuth, limit, async (request, response) => {
  const ids = shiftParams.parse(request.params)
  const input = z.object({ memberId: z.uuid(), updatedAt: z.iso.datetime(), acknowledgeWorkload: z.boolean().default(false) }).strict().parse(request.body)
  await assignReplacement(actor(request), ids.organizationId, ids.shiftId, input)
  response.status(204).end()
})

export default router
