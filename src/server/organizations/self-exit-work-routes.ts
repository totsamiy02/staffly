import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { getExitWork, exitCandidates, resolveExitShift, assignExitTask } from './self-exit-work.ts'

const router = Router()
const base = '/organizations/:organizationId/self-exits/:exitId'
const params = z.object({ organizationId: z.uuid(), exitId: z.uuid(), resourceId: z.uuid().optional() })
const mutation = accountRateLimit('self-exit-work', 60, 60000)
const actor = (request: Request) => (request as AuthenticatedRequest).auth!.userId
router.use(base, requireAuth)

router.get(base, async (request, response) => {
  const { organizationId, exitId } = params.parse(request.params)
  response.set('Cache-Control', 'private, no-store').json(await getExitWork(actor(request), organizationId, exitId))
})

router.get(base + '/:resourceId/candidates', async (request, response) => {
  const { organizationId, exitId, resourceId } = params.parse(request.params)
  const query = z.object({
    kind: z.enum(['shift', 'task']),
    search: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(10000).default(1)
  }).parse(request.query)
  response.set('Cache-Control', 'private, no-store').json(await exitCandidates(actor(request), organizationId, exitId, resourceId!, query.kind, query.search, query.page))
})

router.post(base + '/shifts/:resourceId', mutation, async (request, response) => {
  const { organizationId, exitId, resourceId } = params.parse(request.params)
  const input = z.object({
    updatedAt: z.iso.datetime(),
    memberId: z.uuid().optional(),
    acknowledgeWorkload: z.boolean().default(false),
    reason: z.string().trim().max(500).default('')
  }).strict().parse(request.body)
  await resolveExitShift(actor(request), organizationId, exitId, resourceId!, input)
  response.status(204).end()
})

router.post(base + '/tasks/:resourceId', mutation, async (request, response) => {
  const { organizationId, exitId, resourceId } = params.parse(request.params)
  const input = z.object({ updatedAt: z.iso.datetime(), memberId: z.uuid() }).strict().parse(request.body)
  await assignExitTask(actor(request), organizationId, exitId, resourceId!, input)
  response.status(204).end()
})

export default router
