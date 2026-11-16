import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { previewSelfExit, leaveOrganization } from './self-exit-service.ts'
import { readCache } from '../read-cache.ts'
const router = Router()
const base = '/organizations/:organizationId/leave'
const limit = accountRateLimit('self-exit', 15, 60000)
const identity = (request: Request) => ({
  userId: (request as AuthenticatedRequest).auth!.userId,
  organizationId: z.uuid().parse(request.params.organizationId),
})
// Mounted before point/service/subscription middleware: exiting must remain
// possible without a live point or paid subscription and after a lost response.
router.get(base, requireAuth, async (request, response) => {
  const actor = identity(request)
  response.set('Cache-Control', 'private, no-store').json(await previewSelfExit(actor.userId, actor.organizationId))
})
router.post(base, requireAuth, limit, async (request, response) => {
  const actor = identity(request)
  const { employmentPeriodId } = z.object({ employmentPeriodId: z.uuid() }).strict().parse(request.body)
  const result = await leaveOrganization(actor.userId, actor.organizationId, employmentPeriodId)
  readCache.invalidate(actor.organizationId)
  response.set('Cache-Control', 'private, no-store').json(result)
})

export default router
