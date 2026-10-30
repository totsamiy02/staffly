import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { subscriptionSnapshot } from './access.ts'
import { activateTestPurchase, cancelScheduledChange, createCheckout, selectFreePlan, startBusinessTrial, subscriptionDetails } from './service.ts'
const router = Router(), base = '/organizations/:organizationId/subscription'
const ids = z.object({ organizationId: z.uuid(), orderId: z.uuid().optional() })
const actor = (request: unknown) => (request as AuthenticatedRequest).auth!.userId
const mutation = accountRateLimit('subscription', 20, 60000)
router.use(base, requireAuth, (_q, response, next) => { response.set('Cache-Control', 'private, no-store'); next() })
router.get(base, async (request, response) => response.json(await subscriptionDetails(actor(request), ids.parse(request.params).organizationId)))
router.post(base + '/trial', mutation, async (request, response) => {
  z.object({ confirm: z.literal(true) }).strict().parse(request.body)
  response.json({ subscription: await startBusinessTrial(actor(request), ids.parse(request.params).organizationId) })
})
router.post(base + '/checkout', mutation, async (request, response) => {
  const { plan } = z.object({ plan: z.enum(['TEAM', 'BUSINESS']) }).strict().parse(request.body)
  response.status(201).json({ order: await createCheckout(actor(request), ids.parse(request.params).organizationId, plan) })
})
router.post(base + '/purchases/:orderId/test-activation', mutation, async (request, response) => {
  // No PAN, expiry or CVC is accepted or persisted, even in this test mode.
  const { email } = z.object({ email: z.email().max(254), confirm: z.literal(true), mode: z.literal('test') }).strict().parse(request.body)
  const { organizationId, orderId } = ids.parse(request.params)
  response.json(await activateTestPurchase(actor(request), organizationId, orderId!, email))
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
