import { createHash, randomBytes, randomInt } from 'node:crypto'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from './permissions.ts'

const EMAIL_INVITE_MS = 7 * 24 * 60 * 60 * 1000
const CODE_INVITE_MS = 10 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function digest(value: string) { return createHash('sha256').update(value).digest('hex') }
function activeInviteWhere(now = new Date()) { return { acceptedAt: null, rejectedAt: null, revokedAt: null, expiresAt: { gt: now } } as const }
function isUniqueError(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002') }

function rawInviteCode() {
  const characters = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)])
  return `${characters.slice(0, 4).join('')}-${characters.slice(4, 8).join('')}-${characters.slice(8).join('')}`
}

export async function createEmailInvitation(actorUserId: string, organizationId: string, invitedEmail: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const actorUser = await prisma.user.findUniqueOrThrow({ where: { id: actorUserId } })
  if (actorUser.email === invitedEmail) throw new ApiError(400, 'CANNOT_INVITE_SELF', 'Нельзя пригласить самого себя.')
  const existingUser = await prisma.user.findUnique({ where: { email: invitedEmail } })
  if (existingUser && await prisma.organizationMember.findFirst({ where: { organizationId, userId: existingUser.id, leftAt: null } })) {
    throw new ApiError(409, 'ALREADY_MEMBER', 'Пользователь уже состоит в организации.')
  }

  const now = new Date()
  await prisma.organizationInvite.updateMany({
    where: { organizationId, type: 'EMAIL', invitedEmail, acceptedAt: null, rejectedAt: null, revokedAt: null, expiresAt: { lte: now } },
    data: { revokedAt: now },
  })
  const duplicate = await prisma.organizationInvite.findFirst({ where: { organizationId, type: 'EMAIL', invitedEmail, ...activeInviteWhere(now) } })
  if (duplicate) throw new ApiError(409, 'INVITATION_ALREADY_EXISTS', 'Активное приглашение уже отправлено.')

  const token = randomBytes(32).toString('base64url')
  try {
    const invitation = await prisma.organizationInvite.create({ data: {
      organizationId,
      invitedByUserId: actorUserId,
      type: 'EMAIL',
      invitedEmail,
      tokenHash: digest(token),
      expiresAt: new Date(now.getTime() + EMAIL_INVITE_MS),
    } })
    return { invitation, token, organizationName: actor.organization.name, inviterEmail: actorUser.email }
  } catch (error) {
    if (isUniqueError(error)) throw new ApiError(409, 'INVITATION_ALREADY_EXISTS', 'Активное приглашение уже отправлено.')
    throw error
  }
}

export async function createCodeInvitation(actorUserId: string, organizationId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = rawInviteCode()
    try {
      const invitation = await prisma.organizationInvite.create({ data: {
        organizationId,
        invitedByUserId: actorUserId,
        type: 'CODE',
        tokenHash: digest(code),
        expiresAt: new Date(Date.now() + CODE_INVITE_MS),
      } })
      return { invitation, code }
    } catch (error) { if (!isUniqueError(error) || attempt === 2) throw error }
  }
  throw new ApiError(500, 'INVITATION_CREATE_FAILED', 'Не удалось создать код приглашения.')
}

export async function listPendingInvitations(userEmail: string) {
  const invitations = await prisma.organizationInvite.findMany({
    where: { type: 'EMAIL', invitedEmail: userEmail, ...activeInviteWhere(), organization: { deletedAt: null } },
    include: { organization: true, invitedBy: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return invitations.map((invite) => ({
    id: invite.id,
    organization: { id: invite.organization.id, name: invite.organization.name },
    invitedBy: invite.invitedBy.email,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }))
}

export async function listActiveOrganizationInvitations(actorUserId: string, organizationId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const invitations = await prisma.organizationInvite.findMany({
    where: { organizationId, ...activeInviteWhere() },
    select: { id: true, type: true, invitedEmail: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  return invitations
}

export async function previewEmailInvitation(userEmail: string, token: string) {
  const invite = await prisma.organizationInvite.findUnique({ where: { tokenHash: digest(token) }, include: { organization: true } })
  validateInvitation(invite, 'EMAIL')
  if (invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
  return { id: invite.id, organization: { id: invite.organization.id, name: invite.organization.name }, expiresAt: invite.expiresAt }
}

export async function previewCodeInvitation(userId: string, code: string) {
  const invite = await prisma.organizationInvite.findUnique({ where: { tokenHash: digest(code) }, include: { organization: true } })
  validateInvitation(invite, 'CODE')
  const membership = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invite.organizationId, userId } } })
  if (membership && !membership.leftAt) throw new ApiError(409, 'ALREADY_MEMBER', 'Вы уже состоите в этой организации.')
  return { organization: { id: invite.organization.id, name: invite.organization.name }, expiresAt: invite.expiresAt }
}

type ValidatableInvite = {
  id: string
  type: 'EMAIL' | 'CODE'
  organizationId: string
  invitedEmail: string | null
  expiresAt: Date
  acceptedAt: Date | null
  rejectedAt: Date | null
  revokedAt: Date | null
  organization: { id: string; name: string; deletedAt: Date | null }
} | null

function validateInvitation(invite: ValidatableInvite, type: 'EMAIL' | 'CODE'): asserts invite is Exclude<ValidatableInvite, null> {
  if (!invite || invite.type !== type) throw new ApiError(404, 'INVITATION_NOT_FOUND', 'Приглашение не найдено.')
  if (invite.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  if (invite.acceptedAt) throw new ApiError(409, 'INVITATION_ALREADY_USED', 'Приглашение уже использовано.')
  if (invite.rejectedAt) throw new ApiError(409, 'INVITATION_REJECTED', 'Приглашение отклонено.')
  if (invite.revokedAt) throw new ApiError(410, 'INVITATION_REVOKED', 'Приглашение отозвано.')
  if (invite.expiresAt <= new Date()) throw new ApiError(410, 'INVITATION_EXPIRED', 'Срок приглашения истёк.')
}

async function acceptInvitation(userId: string, userEmail: string, lookup: { id: string } | { tokenHash: string }, expectedType: 'EMAIL' | 'CODE') {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.organizationInvite.findUnique({ where: lookup, include: { organization: true } })
    validateInvitation(invite, expectedType)
    if (expectedType === 'EMAIL' && invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
    const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invite.organizationId, userId } } })
    if (existing && !existing.leftAt) throw new ApiError(409, 'ALREADY_MEMBER', 'Вы уже состоите в этой организации.')
    const claimed = await tx.organizationInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, rejectedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedByUserId: userId },
    })
    if (!claimed.count) throw new ApiError(409, 'INVITATION_ALREADY_USED', 'Приглашение уже использовано.')
    if (existing) await tx.organizationMember.update({ where: { id: existing.id }, data: { leftAt: null, role: 'MEMBER' } })
    else await tx.organizationMember.create({ data: { organizationId: invite.organizationId, userId, role: 'MEMBER' } })
    return { organizationId: invite.organizationId }
  }, { isolationLevel: 'Serializable' })
}

export function acceptEmailInvitation(userId: string, userEmail: string, inviteId: string) {
  return acceptInvitation(userId, userEmail, { id: inviteId }, 'EMAIL')
}

export function acceptCodeInvitation(userId: string, userEmail: string, code: string) {
  return acceptInvitation(userId, userEmail, { tokenHash: digest(code) }, 'CODE')
}

export async function rejectEmailInvitation(userEmail: string, inviteId: string) {
  const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId }, include: { organization: true } })
  validateInvitation(invite, 'EMAIL')
  if (invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
  const rejected = await prisma.organizationInvite.updateMany({ where: { id: inviteId, rejectedAt: null, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { rejectedAt: new Date() } })
  if (!rejected.count) throw new ApiError(409, 'INVITATION_ALREADY_USED', 'Приглашение уже обработано.')
}

export async function revokeInvitation(actorUserId: string, organizationId: string, inviteId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const revoked = await prisma.organizationInvite.updateMany({ where: { id: inviteId, organizationId, acceptedAt: null, rejectedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!revoked.count) throw new ApiError(404, 'INVITATION_NOT_FOUND', 'Активное приглашение не найдено.')
}
