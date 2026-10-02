import { locationWhere } from './location-context.ts'
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'
import { prisma } from '../db.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from './permissions.ts'

// Domain-separated key keeps invitation material encrypted across navigation/restarts.
function codeKey() {
  const secret = process.env.INVITE_CODE_SECRET || process.env.JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('Invitation encryption requires a secret of at least 32 characters')
  return createHash('sha256').update('staffly-invite-code-v1:').update(secret).digest()
}
function encryptCode(code: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', codeKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}
function decryptCode(value: string | null) {
  if (!value) return null
  const bytes = Buffer.from(value, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', codeKey(), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
const EMAIL_INVITE_MS = 24 * 60 * 60 * 1000
const CODE_INVITE_MS = 10 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function inviterIdentity(user: { lastName: string | null; firstName: string | null; middleName: string | null; email: string }) {
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email
}

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
  if (existingUser && await prisma.organizationMember.findFirst({ where: { organizationId, userId: existingUser.id, leftAt: null, locationMemberships: { some: { locationId: actor.locationId, leftAt: null } } } })) {
    throw new ApiError(409, 'ALREADY_MEMBER', 'Пользователь уже состоит в организации.')
  }

  const now = new Date()
  await prisma.organizationInvite.updateMany({
    where: { organizationId, ...locationWhere(organizationId), type: 'EMAIL', invitedEmail, acceptedAt: null, rejectedAt: null, revokedAt: null, expiresAt: { lte: now } },
    data: { revokedAt: now },
  })
  const duplicate = await prisma.organizationInvite.findFirst({ where: { organizationId, ...locationWhere(organizationId), type: 'EMAIL', invitedEmail, ...activeInviteWhere(now) } })
  if (duplicate) throw new ApiError(409, 'INVITATION_ALREADY_EXISTS', 'Активное приглашение уже отправлено.')

  const token = randomBytes(32).toString('base64url')
  try {
    const invitation = await prisma.organizationInvite.create({ data: {
      organizationId,
      locationId: actor.locationId,
      invitedByUserId: actorUserId,
      type: 'EMAIL',
      invitedEmail,
      createdAt: now,
      tokenHash: digest(token),
      expiresAt: new Date(now.getTime() + EMAIL_INVITE_MS),
    } })
    return { invitation, token, organizationName: actor.organization.name, inviterName: inviterIdentity(actorUser), logoUrl: mediaUrl(actor.organization.logoFileId) }
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
        locationId: actor.locationId,
        invitedByUserId: actorUserId,
        type: 'CODE',
        tokenHash: digest(code),
        codeCiphertext: encryptCode(code),
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
    include: { organization: true, invitedBy: { select: { email: true, firstName: true, lastName: true, middleName: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return invitations.map((invite) => ({
    id: invite.id,
    organization: { id: invite.organization.id, name: invite.organization.name, logoUrl: mediaUrl(invite.organization.logoFileId) },
    invitedBy: inviterIdentity(invite.invitedBy),
    readAt: invite.readAt,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }))
}

export async function listActiveOrganizationInvitations(actorUserId: string, organizationId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const invitations = await prisma.organizationInvite.findMany({
    where: { organizationId, ...locationWhere(organizationId), ...activeInviteWhere() },
    select: { id: true, type: true, invitedEmail: true, expiresAt: true, createdAt: true, codeCiphertext: true },
    orderBy: { createdAt: 'desc' },
  })
  return invitations.map(({ codeCiphertext, ...item }) => ({ ...item, code: decryptCode(codeCiphertext) }))
}

export async function previewEmailInvitation(userEmail: string, token: string) {
  const invite = await prisma.organizationInvite.findUnique({ where: { tokenHash: digest(token) }, include: { organization: true, invitedBy: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
  validateInvitation(invite, 'EMAIL')
  if (invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
  return { id: invite.id, organization: { id: invite.organization.id, name: invite.organization.name, logoUrl: mediaUrl(invite.organization.logoFileId) }, invitedBy: inviterIdentity(invite.invitedBy), expiresAt: invite.expiresAt }
}

export async function previewCodeInvitation(userId: string, code: string) {
  const invite = await prisma.organizationInvite.findUnique({ where: { tokenHash: digest(code) }, include: { organization: true, invitedBy: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
  validateInvitation(invite, 'CODE')
  const membership = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invite.organizationId, userId } } })
  if (membership && !membership.leftAt) throw new ApiError(409, 'ALREADY_MEMBER', 'Вы уже состоите в этой организации.')
  return { organization: { id: invite.organization.id, name: invite.organization.name, logoUrl: mediaUrl(invite.organization.logoFileId) }, invitedBy: inviterIdentity(invite.invitedBy), expiresAt: invite.expiresAt }
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
    const invite = await tx.organizationInvite.findUnique({ where: lookup, include: { organization: true, invitedBy: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
    validateInvitation(invite, expectedType)
    if (expectedType === 'EMAIL' && invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
    const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invite.organizationId, userId } } })
    if (existing && !existing.leftAt && (!invite.locationId || await tx.locationMember.findFirst({ where: { memberId: existing.id, locationId: invite.locationId, leftAt: null } }))) throw new ApiError(409, 'ALREADY_MEMBER', 'Вы уже состоите в этой организации.')
    const claimed = await tx.organizationInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, rejectedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedByUserId: userId, readAt: new Date() },
    })
    if (!claimed.count) throw new ApiError(409, 'INVITATION_ALREADY_USED', 'Приглашение уже использовано.')
    if (invite.locationId && !await tx.organizationLocation.findFirst({ where: { id: invite.locationId, organizationId: invite.organizationId, archivedAt: null } })) throw new ApiError(410, 'LOCATION_CLOSED', 'Точка приглашения закрыта.')
    const member = existing ? existing.leftAt ? await tx.organizationMember.update({ where: { id: existing.id }, data: { leftAt: null, role: 'MEMBER' } }) : existing : await tx.organizationMember.create({ data: { organizationId: invite.organizationId, userId, role: 'MEMBER' } })
    const locationId = invite.locationId ?? (await tx.organizationLocation.findFirstOrThrow({ where: { organizationId: invite.organizationId, archivedAt: null }, orderBy: { createdAt: 'asc' } })).id
    await tx.locationMember.upsert({ where: { locationId_memberId: { locationId, memberId: member.id } }, create: { organizationId: invite.organizationId, locationId, memberId: member.id }, update: { leftAt: null, role: 'MEMBER' } })
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
  const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId }, include: { organization: true, invitedBy: { select: { email: true, firstName: true, lastName: true, middleName: true } } } })
  validateInvitation(invite, 'EMAIL')
  if (invite.invitedEmail !== userEmail) throw new ApiError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение предназначено для другого аккаунта.')
  const rejected = await prisma.organizationInvite.updateMany({ where: { id: inviteId, rejectedAt: null, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { rejectedAt: new Date(), readAt: new Date() } })
  if (!rejected.count) throw new ApiError(409, 'INVITATION_ALREADY_USED', 'Приглашение уже обработано.')
}

export async function revokeInvitation(actorUserId: string, organizationId: string, inviteId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER', 'ADMIN'])
  const revoked = await prisma.organizationInvite.updateMany({ where: { id: inviteId, organizationId, ...locationWhere(organizationId), acceptedAt: null, rejectedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
  if (!revoked.count) throw new ApiError(404, 'INVITATION_NOT_FOUND', 'Активное приглашение не найдено.')
}
