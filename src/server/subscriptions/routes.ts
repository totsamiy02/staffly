import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { subscriptionSnapshot } from './access.ts'
import { cancelScheduledChange, selectFreePlan, selectOrganizationPlan, subscriptionDetails } from './service.ts'
const router = Router(), base = '/organizations/:organizationId/subscription'
const ids = z.object({ organizationId: z.uuid(), orderId: z.uuid().optional() })
const actor = (request: unknown) => (request as AuthenticatedRequest).auth!.userId
const mutation = accountRateLimit('subscription', 20, 60000)
router.use(base, requireAuth, (_q, response, next) => { response.set('Cache-Control', 'private, no-store'); next() })
router.get(base, async (request, response) => response.json(await subscriptionDetails(actor(request), ids.parse(request.params).organizationId)))
router.post(base + '/select', mutation, async (request,response) => {
  const { plan, revision } = z.object({ plan:z.enum(['FREE','TEAM','BUSINESS']),revision:z.number().int().min(0).max(2147483647),confirm:z.literal(true) }).strict().parse(request.body)
  response.json(await selectOrganizationPlan(actor(request),ids.parse(request.params).organizationId,plan,revision))
})
async function manualOnly(request: unknown, organizationId: string): Promise<never> {
  const member = await getMembership(actor(request), organizationId)
  if (!member.owner) throw new ApiError(403, 'OWNER_REQUIRED', 'Выбрать тариф может только владелец организации.')
  throw new ApiError(403, 'SUBSCRIPTION_MANUAL_ONLY', 'Оплата не требуется. Выберите тариф в настройках организации и подтвердите подключение.')
}
router.post(base + '/trial', mutation, async (request) => {
  z.object({ confirm: z.literal(true) }).strict().parse(request.body)
  await manualOnly(request, ids.parse(request.params).organizationId)
})
router.post(base + '/checkout', mutation, async (request) => {
  z.object({ plan: z.enum(['TEAM','BUSINESS']) }).strict().parse(request.body)
  await manualOnly(request, ids.parse(request.params).organizationId)
})
router.post(base + '/purchases/:orderId/test-activation', mutation, async (request) => {
  z.object({ email:z.email().max(254),confirm:z.literal(true),mode:z.literal('test') }).strict().parse(request.body)
  await manualOnly(request, ids.parse(request.params).organizationId)
})
router.post(base + '/free', mutation, async (request, response) => {
  const { immediate } = z.object({ confirm: z.literal(true), immediate: z.boolean().default(false) }).strict().parse(request.body)
  response.json({ subscription: await selectFreePlan(actor(request), ids.parse(request.params).organizationId, immediate) })
})
router.delete(base + '/scheduled-change', mutation, async (request, response) => response.json({ subscription: await cancelScheduledChange(actor(request), ids.parse(request.params).organizationId) }))
// Expired organizations retain reading, file delivery, capacity cleanup and
// access/security management. Billing remains reachable without a paid plan.
export const subscriptionWritePolicy: RequestHandler = async (request, _response, next) => {
  if (['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(request.method) || /\/(subscription|access)(\/|$)/.test(request.path) || /\/documents\/[^/]+\/content$/.test(request.path) || /\/(ownership-transfer|delete)\//.test(request.path)) return next()
  const organizationId = z.uuid().parse(request.params.organizationId)
  await getMembership(actor(request), organizationId)
  const snapshot = await subscriptionSnapshot(organizationId)
  if (snapshot.readOnly) throw new ApiError(403, 'SUBSCRIPTION_EXPIRED', 'Подписка завершилась. Данные доступны для просмотра.', { organizationId })
  next()
}
export default router
