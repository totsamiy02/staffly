import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from './permissions.ts'

const configuredSecret = process.env.JWT_SECRET
if (!configuredSecret) throw new Error('JWT_SECRET is missing')
const SECRET = configuredSecret
const CODE_MS = 10 * 60 * 1000
const COOLDOWN_MS = 60 * 1000
const MAX_ATTEMPTS = 5

type Action = 'TRANSFER_OWNERSHIP' | 'DELETE_ORGANIZATION'
function newCode() { return randomInt(0, 1_000_000).toString().padStart(6, '0') }
function codeHash(userId: string, organizationId: string, action: Action, code: string) {
  return createHmac('sha256', SECRET).update(`${userId}:${organizationId}:${action}:${code}`).digest('hex')
}
function equalHash(left: string, right: string) { return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')) }

async function createSensitiveToken(userId: string, organizationId: string, action: Action, targetUserId?: string) {
  const latest = await prisma.sensitiveActionToken.findFirst({ where: { userId, organizationId, action }, orderBy: { createdAt: 'desc' } })
  if (latest && latest.createdAt > new Date(Date.now() - COOLDOWN_MS)) throw new ApiError(429, 'CODE_COOLDOWN', 'Новый код можно запросить через минуту.')
  const code = newCode()
  await prisma.$transaction([
    prisma.sensitiveActionToken.deleteMany({ where: { userId, organizationId, action, usedAt: null } }),
    prisma.sensitiveActionToken.create({ data: {
      userId,
      organizationId,
      action,
      targetUserId,
      codeHash: codeHash(userId, organizationId, action, code),
      expiresAt: new Date(Date.now() + CODE_MS),
    } }),
  ])
  return code
}

export async function requestOwnershipTransfer(userId: string, organizationId: string, targetMemberId: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  const target = await prisma.organizationMember.findFirst({ where: { id: targetMemberId, organizationId }, include: { user: true } })
  if (!target || target.user.deletedAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  if (target.role === 'OWNER' || target.userId === userId) throw new ApiError(400, 'INVALID_OWNERSHIP_TARGET', 'Выберите другого участника организации.')
  const code = await createSensitiveToken(userId, organizationId, 'TRANSFER_OWNERSHIP', target.userId)
  return { code, organizationName: actor.organization.name }
}

export async function requestOrganizationDeletion(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  const code = await createSensitiveToken(userId, organizationId, 'DELETE_ORGANIZATION')
  return { code, organizationName: actor.organization.name }
}

async function claimSensitiveToken(tx: Prisma.TransactionClient, userId: string, organizationId: string, action: Action, code: string) {
  const token = await tx.sensitiveActionToken.findFirst({ where: { userId, organizationId, action, usedAt: null }, orderBy: { createdAt: 'desc' } })
  if (!token || token.expiresAt <= new Date() || token.attempts >= MAX_ATTEMPTS) throw new ApiError(400, 'INVALID_VERIFICATION_CODE', 'Код неверен или срок его действия истёк.')
  const valid = equalHash(token.codeHash, codeHash(userId, organizationId, action, code))
  const claimed = await tx.sensitiveActionToken.updateMany({
    where: { id: token.id, usedAt: null, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 }, ...(valid ? { usedAt: new Date() } : {}) },
  })
  if (!claimed.count || !valid) throw new ApiError(400, 'INVALID_VERIFICATION_CODE', 'Код неверен или срок его действия истёк.')
  return token
}

export async function confirmOwnershipTransfer(userId: string, organizationId: string, code: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  return prisma.$transaction(async (tx) => {
    const token = await claimSensitiveToken(tx, userId, organizationId, 'TRANSFER_OWNERSHIP', code)
    if (!token.targetUserId) throw new ApiError(400, 'INVALID_OWNERSHIP_TARGET', 'Участник для передачи владения не найден.')
    const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: token.targetUserId } }, include: { user: true } })
    if (!target || target.user.deletedAt || target.role === 'OWNER') throw new ApiError(400, 'INVALID_OWNERSHIP_TARGET', 'Участник для передачи владения недоступен.')
    await tx.organizationMember.update({ where: { id: actor.id }, data: { role: 'ADMIN' } })
    await tx.organizationMember.update({ where: { id: target.id }, data: { role: 'OWNER' } })
    return { ownerUserId: target.userId }
  }, { isolationLevel: 'Serializable' })
}

export async function confirmOrganizationDeletion(userId: string, organizationId: string, code: string) {
  const actor = await getMembership(userId, organizationId)
  requireOrganizationRole(actor.role, ['OWNER'])
  return prisma.$transaction(async (tx) => {
    await claimSensitiveToken(tx, userId, organizationId, 'DELETE_ORGANIZATION', code)
    const now = new Date()
    const deleted = await tx.organization.updateMany({ where: { id: organizationId, deletedAt: null }, data: { deletedAt: now } })
    if (!deleted.count) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
    await tx.organizationInvite.updateMany({ where: { organizationId, acceptedAt: null, rejectedAt: null, revokedAt: null }, data: { revokedAt: now } })
    return { deleted: true }
  }, { isolationLevel: 'Serializable' })
}
