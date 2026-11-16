import { Router, type Request } from 'express'
import { z } from 'zod'
import { memberBulkBody, memberBulkTarget } from '../../shared/member-bulk.ts'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { ApiError } from '../api-error.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { applyMemberBulk, memberBulkCandidates } from './member-bulk-service.ts'

const router = Router()
const base = '/organizations/:organizationId/member-actions'
const mutationLimit = accountRateLimit('member-bulk', 30, 60000)
const candidatesLimit = accountRateLimit('member-bulk-candidates', 60, 60000)
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте список сотрудников и параметры назначения.', z.flattenError(result.error).fieldErrors)
  return result.data
}
function context(request: Request) {
  return { organizationId: parse(z.uuid(), request.params.organizationId), userId: (request as AuthenticatedRequest).auth!.userId }
}
router.get(base + '/candidates', requireAuth, candidatesLimit, async (request, response) => {
  const { userId, organizationId } = context(request)
  const options = parse(memberBulkTarget.extend({ search: z.string().trim().max(160).default('') }), request.query)
  response.json(await memberBulkCandidates(userId, organizationId, options, options.search))
})
router.post(base, requireAuth, mutationLimit, async (request, response) => {
  const { userId, organizationId } = context(request)
  response.json(await applyMemberBulk(userId, organizationId, parse(memberBulkBody, request.body)))
})
export default router
