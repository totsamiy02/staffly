import { mediaUrl } from '../storage/image-service.ts'
import { prisma } from '../db.ts'
import { getMembership, requireOrganizationRole } from './permissions.ts'
import { scopedLocationId } from './location-context.ts'
import { archiveLocation, requestLocationClosure, assignLocationMember, deleteTeam, listLocations, locationOverview, listTeams, locationMemberBody, removeLocationMember, saveLocation, saveTeam, teamBody, transferBody, transferMember } from './location-service.ts'
import { locationBody } from './schemas.ts'
import { listNotificationHistory, readHistoryNotification, updateAllNotifications } from './notification-service.ts'
import { Router, type Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { deliverOrganizationCreated, deliverOrganizationInvitation, deliverSensitiveActionCode } from '../mail.ts'
import { ApiError } from '../api-error.ts'
import { changeMemberRole, createOrganization, getOrganization, listAccountNotifications, listMembers, listMembersPage, listOrganizations, readAccountNotification, removeMember, updateOrganization } from './organization-service.ts'
import { acceptCodeInvitation, acceptEmailInvitation, createCodeInvitation, createEmailInvitation, listActiveOrganizationInvitations, listPendingInvitations, previewCodeInvitation, previewEmailInvitation, rejectEmailInvitation, revokeInvitation } from './invitation-service.ts'
import { confirmOrganizationDeletion, confirmOwnershipTransfer, requestOrganizationDeletion, requestOwnershipTransfer } from './sensitive-action-service.ts'
import { createOrganizationBody, emailInvitationBody, inviteCodeBody, inviteParams, memberListQuery, memberParams, organizationIdParams, ownershipRequestBody, roleBody, sensitiveCodeBody, updateOrganizationBody } from './schemas.ts'

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
router.get('/notifications', async (request, response) => {
  const options = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(512).optional(), unread: z.enum(['true', 'false']).optional(), organizationId: z.string().uuid().optional(), locationId: z.string().uuid().optional(), category: z.enum(['SHIFT', 'REQUEST', 'ABSENCE', 'ROLE', 'ORGANIZATION', 'DOCUMENT']).optional() }), request.query)
  response.json(await listNotificationHistory(auth(request).userId, auth(request).email, { ...options, unread: options.unread === 'true' }))
})
router.post('/notifications/:id/read', async (request, response) => {
  const { id } = parse(z.object({ id: z.string().regex(/^(event|invite):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }), request.params)
  const { unread, organizationId } = parse(z.object({ unread: z.boolean().default(false), organizationId: z.string().uuid().optional() }), request.body)
  await readHistoryNotification(auth(request).userId, auth(request).email, id, unread, organizationId)
  response.status(204).end()
})

router.post('/notifications/read-all', async (request, response) => {
  const options = parse(z.object({ organizationId: z.string().uuid().optional() }), request.body)
  await updateAllNotifications(auth(request).userId, auth(request).email, options)
  response.status(204).end()
})
router.delete('/notifications/:id', async (request, response) => {
  const { id } = parse(z.object({ id: z.string().regex(/^(event|invite):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }), request.params)
  const options = parse(z.object({ organizationId: z.string().uuid().optional() }), request.query)
  await updateAllNotifications(auth(request).userId, auth(request).email, options, id)
  response.status(204).end()
})

router.get('/account-notifications', async (request, response) => response.json({ notifications: await listAccountNotifications(auth(request).userId, parse(z.object({ organizationId: z.string().uuid().optional() }), request.query).organizationId) }))
router.post('/account-notifications/:notificationId/read', async (request, response) => {
  const notificationId = parse(z.object({ notificationId: z.string().uuid() }), request.params).notificationId
  await readAccountNotification(auth(request).userId, notificationId)
  response.status(204).end()
})

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

router.patch('/organizations/:organizationId', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const input = parse(updateOrganizationBody, request.body)
  response.json({ organization: await updateOrganization(auth(request).userId, organizationId, input) })
})

router.get('/organizations/:organizationId/members', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const options = parse(memberListQuery, request.query)
  if (options.page || options.pageSize || options.role || options.search || options.positionId || options.directory || options.pointId) {
    response.json(await listMembersPage(auth(request).userId, organizationId, options))
    return
  }
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
  await removeLocationMember(auth(request).userId, organizationId, scopedLocationId(organizationId)!, memberId)
  response.status(204).end()
})

router.delete('/organizations/:organizationId/members/:memberId/organization', async (request, response) => {
  const { organizationId, memberId } = parse(memberParams, request.params)
  const actor = await getMembership(auth(request).userId, organizationId); requireOrganizationRole(actor.organizationRole, ['OWNER'])
  await removeMember(auth(request).userId, organizationId, memberId); response.status(204).end()
})
router.post('/organizations/:organizationId/invitations/email', invitationLimiter, async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const { email } = parse(emailInvitationBody, request.body)
  const result = await createEmailInvitation(auth(request).userId, organizationId, email)
  let emailDelivered = true
  try { await deliverOrganizationInvitation(email, result.organizationName, result.inviterName, result.token, result.invitation.expiresAt, result.logoUrl) }
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

router.get('/organizations/:organizationId/locations', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.json({ locations: await listLocations(auth(request).userId, organizationId) })
})
router.get('/organizations/:organizationId/locations/overview', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.json({ locations: await locationOverview(auth(request).userId, organizationId) })
})
router.post('/organizations/:organizationId/locations', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  response.status(201).json({ location: await saveLocation(auth(request).userId, organizationId, null, parse(locationBody, request.body)) })
})
router.patch('/organizations/:organizationId/locations/:locationId', async (request, response) => {
  const { organizationId, locationId } = parse(organizationIdParams.extend({ locationId: z.uuid() }), request.params)
  response.json({ location: await saveLocation(auth(request).userId, organizationId, locationId, parse(locationBody, request.body)) })
})
router.delete('/organizations/:organizationId/locations/:locationId', async (request, response) => {
  const { organizationId, locationId } = parse(organizationIdParams.extend({ locationId: z.uuid() }), request.params)
  await archiveLocation(auth(request).userId, organizationId, locationId, parse(sensitiveCodeBody, request.body).code); response.status(204).end()
})
router.post('/organizations/:organizationId/locations/:locationId/close/request', sensitiveLimiter, async (request, response) => {
  const { organizationId, locationId } = parse(organizationIdParams.extend({ locationId: z.uuid() }), request.params)
  const result = await requestLocationClosure(auth(request).userId, organizationId, locationId)
  await deliverSensitiveActionCode('location', auth(request).email, `${result.organizationName} · ${result.locationName}`, result.code)
  response.status(202).json({ message: 'Код отправлен на почту владельца.' })
})
router.post('/organizations/:organizationId/locations/:locationId/members', async (request, response) => {
  const { organizationId, locationId } = parse(organizationIdParams.extend({ locationId: z.uuid() }), request.params)
  const { memberId, role } = parse(locationMemberBody, request.body)
  response.json({ member: await assignLocationMember(auth(request).userId, organizationId, locationId, memberId, role) })
})
router.get('/organizations/:organizationId/all-members', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  await getMembership(auth(request).userId, organizationId)
  // The organization directory is public to its members, like point calendars.
  const members = await prisma.organizationMember.findMany({ where: { organizationId, leftAt: null, user: { deletedAt: null } }, select: { id: true, user: { select: { email: true, firstName: true, lastName: true, middleName: true, avatarFileId: true } }, role: true, locationMemberships: { where: { leftAt: null, location: { archivedAt: null } }, select: { locationId: true, role: true } } } })
  response.json({ members: members.map(m => ({ id: m.id, displayName: [m.user.lastName, m.user.firstName, m.user.middleName].filter(Boolean).join(' ') || m.user.email, email: m.user.email, avatarUrl: mediaUrl(m.user.avatarFileId), role: m.role, locations: m.locationMemberships })) })
})
router.get('/organizations/:organizationId/teams', async (request, response) => response.json({ teams: await listTeams(auth(request).userId, parse(organizationIdParams, request.params).organizationId) }))
router.post('/organizations/:organizationId/teams', async (request, response) => response.status(201).json({ team: await saveTeam(auth(request).userId, parse(organizationIdParams, request.params).organizationId, null, parse(teamBody, request.body)) }))
router.patch('/organizations/:organizationId/teams/:teamId', async (request, response) => {
  const { organizationId, teamId } = parse(organizationIdParams.extend({ teamId: z.uuid() }), request.params)
  response.json({ team: await saveTeam(auth(request).userId, organizationId, teamId, parse(teamBody, request.body)) })
})
router.delete('/organizations/:organizationId/teams/:teamId', async (request, response) => {
  const { organizationId, teamId } = parse(organizationIdParams.extend({ teamId: z.uuid() }), request.params)
  await deleteTeam(auth(request).userId, organizationId, teamId); response.status(204).end()
})
router.post('/organizations/:organizationId/transfers', async (request, response) => response.status(201).json({ transfer: await transferMember(auth(request).userId, parse(organizationIdParams, request.params).organizationId, parse(transferBody, request.body)) }))
router.get('/organizations/:organizationId/transfers', async (request, response) => {
  const { organizationId } = parse(organizationIdParams, request.params)
  const actor = await getMembership(auth(request).userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  response.json({ transfers: await prisma.locationTransfer.findMany({ where: { organizationId, OR: [{ fromLocationId: actor.locationId }, { toLocationId: actor.locationId }] }, include: { member: { include: { user: { select: { firstName: true, lastName: true, email: true } } } }, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }) })
})
export default router
