import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { deliverOrganizationCreated, deliverOrganizationInvitation, deliverSensitiveActionCode } from '../mail.ts'
import { ApiError } from '../api-error.ts'
import { changeMemberRole, createOrganization, getOrganization, listMembers, listOrganizations, removeMember } from './organization-service.ts'
import { acceptCodeInvitation, acceptEmailInvitation, createCodeInvitation, createEmailInvitation, listActiveOrganizationInvitations, listPendingInvitations, previewCodeInvitation, previewEmailInvitation, rejectEmailInvitation, revokeInvitation } from './invitation-service.ts'
import { confirmOrganizationDeletion, confirmOwnershipTransfer, requestOrganizationDeletion, requestOwnershipTransfer } from './sensitive-action-service.ts'
import { createOrganizationBody, emailInvitationBody, inviteCodeBody, inviteParams, memberParams, organizationIdParams, ownershipRequestBody, roleBody, sensitiveCodeBody } from './schemas.ts'

const router = Router()
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много запросов. Попробуйте позже.' } })
const invitationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'TOO_MANY_REQUESTS', message: 'Слишком много приглашений. Попробуйте позже.' } })

router.use(requireAuth)

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте введённые данные.', z.flattenError(result.error).fieldErrors)
  return result.data
}

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }

router.get('/organizations', async (request, response) => response.json({ organizations: await listOrganizations(auth(request).userId) }))

router.post('/organizations', async (request, response) => {
  const input = parse(createOrganizationBody, request.body)
  const current = auth(request)
  const organization = await createOrganization(current.userId, input)
  void deliverOrganizationCreated(current.email, organization.name).catch((error) => console.error('Organization-created email failed:', error))
  response.status(201).json({ organization })
})

router.get('/organizations/:organizationId', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.json({ organization: await getOrganization(auth(request).userId, organizationId) })
})

router.get('/organizations/:organizationId/members', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.json({ members: await listMembers(auth(request).userId, organizationId) })
})

router.patch('/organizations/:organizationId/members/:memberId/role', async (request, response) => {
  const { organizationId, memberId } = parse(memberParams, request.params)
  const { role } = parse(roleBody, request.body)
  const member = await changeMemberRole(auth(request).userId, organizationId, memberId, role)
  response.json({ member })
})

router.delete('/organizations/:organizationId/members/:memberId', async (request, response) => {
  const { organizationId, memberId } = parse(memberParams, request.params)
  await removeMember(auth(request).userId, organizationId, memberId)
  response.status(204).end()
})

router.post('/organizations/:organizationId/invitations/email', invitationLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { email } = parse(emailInvitationBody, request.body)
  const result = await createEmailInvitation(auth(request).userId, organizationId, email)
  let emailDelivered = true
  try { await deliverOrganizationInvitation(email, result.organizationName, result.inviterEmail, result.token, result.invitation.expiresAt) }
  catch (error) { emailDelivered = false; console.error('Organization invitation email failed:', error) }
  response.status(201).json({ invitation: { id: result.invitation.id, email, expiresAt: result.invitation.expiresAt }, emailDelivered })
})

router.post('/organizations/:organizationId/invitations/code', invitationLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const result = await createCodeInvitation(auth(request).userId, organizationId)
  response.status(201).json({ invitationId: result.invitation.id, code: result.code, expiresAt: result.invitation.expiresAt })
})

router.get('/organizations/:organizationId/invitations', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.json({ invitations: await listActiveOrganizationInvitations(auth(request).userId, organizationId) })
})

router.delete('/organizations/:organizationId/invitations/:inviteId', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { inviteId } = parse(inviteParams, request.params)
  await revokeInvitation(auth(request).userId, organizationId, inviteId)
  response.status(204).end()
})

router.get('/invitations', async (request, response) => response.json({ invitations: await listPendingInvitations(auth(request).email) }))

router.post('/invitations/email/preview', async (request, response) => {
  const { token } = parse(z.object({ token: z.string().min(32).max(256) }), request.body)
  response.json({ invitation: await previewEmailInvitation(auth(request).email, token) })
})

router.post('/invitations/:inviteId/accept', async (request, response) => {
  const { inviteId } = parse(inviteParams, request.params)
  response.json(await acceptEmailInvitation(auth(request).userId, auth(request).email, inviteId))
})

router.post('/invitations/:inviteId/reject', async (request, response) => {
  const { inviteId } = parse(inviteParams, request.params)
  await rejectEmailInvitation(auth(request).email, inviteId)
  response.status(204).end()
})

router.post('/invitations/code/preview', sensitiveLimiter, async (request, response) => {
  const { code } = parse(inviteCodeBody, request.body)
  response.json({ invitation: await previewCodeInvitation(auth(request).userId, code) })
})

router.post('/invitations/code/accept', sensitiveLimiter, async (request, response) => {
  const { code } = parse(inviteCodeBody, request.body)
  response.json(await acceptCodeInvitation(auth(request).userId, auth(request).email, code))
})

router.post('/organizations/:organizationId/ownership-transfer/request', sensitiveLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { targetMemberId } = parse(ownershipRequestBody, request.body)
  const result = await requestOwnershipTransfer(auth(request).userId, organizationId, targetMemberId)
  await deliverSensitiveActionCode('ownership', auth(request).email, result.organizationName, result.code)
  response.status(202).json({ message: 'Код подтверждения отправлен владельцу.' })
})

router.post('/organizations/:organizationId/ownership-transfer/confirm', sensitiveLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { code } = parse(sensitiveCodeBody, request.body)
  response.json(await confirmOwnershipTransfer(auth(request).userId, organizationId, code))
})

router.post('/organizations/:organizationId/delete/request', sensitiveLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const result = await requestOrganizationDeletion(auth(request).userId, organizationId)
  await deliverSensitiveActionCode('deletion', auth(request).email, result.organizationName, result.code)
  response.status(202).json({ message: 'Код подтверждения отправлен владельцу.' })
})

router.post('/organizations/:organizationId/delete/confirm', sensitiveLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { code } = parse(sensitiveCodeBody, request.body)
  response.json(await confirmOrganizationDeletion(auth(request).userId, organizationId, code))
})

export default router
