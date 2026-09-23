import type { OrganizationRole } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { deliverRoleChanged } from '../mail.ts'
import { assertCanChangeRole, assertCanRemoveMember, getMembership } from './permissions.ts'
import { mediaUrl } from '../storage/image-service.ts'

export type CreateOrganizationInput = { name: string; description: string | null; timezone: string }
export type UpdateOrganizationInput = CreateOrganizationInput & { contactEmail: string | null; phone: string | null; website: string | null; address: string | null }

export async function createOrganization(userId: string, input: CreateOrganizationInput) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { ...input, createdByUserId: userId } })
    await tx.organizationMember.create({ data: { organizationId: organization.id, userId, role: 'OWNER' } })
    return { ...organization, logoUrl: null, role: 'OWNER' as const, memberCount: 1 }
  })
}

export async function listOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, leftAt: null, organization: { deletedAt: null } },
    include: { organization: { include: { _count: { select: { members: { where: { leftAt: null } } } } } } },
    orderBy: { joinedAt: 'asc' },
  })
  return memberships.map(({ organization, role, joinedAt }) => ({
    id: organization.id,
    name: organization.name,
    description: organization.description,
    timezone: organization.timezone,
    role,
    joinedAt,
    memberCount: organization._count.members,
    contactEmail: organization.contactEmail,
    phone: organization.phone,
    website: organization.website,
    address: organization.address,
    logoUrl: mediaUrl(organization.logoFileId),
  }))
}

export async function getOrganization(userId: string, organizationId: string) {
  const membership = await getMembership(userId, organizationId)
  const memberCount = await prisma.organizationMember.count({ where: { organizationId, leftAt: null, user: { deletedAt: null } } })
  return {
    id: membership.organization.id,
    name: membership.organization.name,
    description: membership.organization.description,
    timezone: membership.organization.timezone,
    role: membership.role,
    memberCount,
    contactEmail: membership.organization.contactEmail,
    phone: membership.organization.phone,
    website: membership.organization.website,
    address: membership.organization.address,
    logoUrl: mediaUrl(membership.organization.logoFileId),
  }
}

export async function updateOrganization(userId: string, organizationId: string, input: UpdateOrganizationInput) {
  const membership = await getMembership(userId, organizationId)
  if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для изменения организации.')
  return prisma.organization.update({ where: { id: organizationId }, data: input })
}

export async function listMembers(userId: string, organizationId: string) {
  await getMembership(userId, organizationId)
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, leftAt: null, organization: { deletedAt: null }, user: { deletedAt: null } },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, lastSeenAt: true, avatarFileId: true } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })
  const onlineThreshold = Date.now() - 2 * 60 * 1000
  return members.map((member) => {
    const displayName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || member.user.email.split('@')[0]
    return { id: member.id, userId: member.userId, email: member.user.email, displayName, firstName: member.user.firstName, lastName: member.user.lastName, middleName: member.user.middleName, phone: member.user.phone, bio: member.user.bio, avatarUrl: mediaUrl(member.user.avatarFileId), lastSeenAt: member.user.lastSeenAt, online: Boolean(member.user.lastSeenAt && member.user.lastSeenAt.getTime() > onlineThreshold), role: member.role, joinedAt: member.joinedAt }
  })
}

export async function changeMemberRole(actorUserId: string, organizationId: string, memberId: string, nextRole: Exclude<OrganizationRole, 'OWNER'>) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null }, include: { user: true } })
  if (!target || target.user.deletedAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  assertCanChangeRole(actor.role, target.role)
  if (target.role === nextRole) return target
  const roleName = nextRole === 'ADMIN' ? 'Администратор' : 'Пользователь'
  const member = await prisma.$transaction(async (tx) => {
    const updated = await tx.organizationMember.update({ where: { id: target.id }, data: { role: nextRole } })
    await tx.accountNotification.create({ data: { userId: target.userId, organizationId, type: 'ROLE_CHANGED', title: 'Роль изменена', message: `В организации «${actor.organization.name}» вам назначена роль «${roleName}».` } })
    return updated
  })
  void deliverRoleChanged(target.user.email, actor.organization.name, roleName).catch((error) => console.error('Role-changed email failed:', error))
  return member
}

export async function listAccountNotifications(userId: string) {
  return prisma.accountNotification.findMany({ where: { userId, readAt: null, organization: { deletedAt: null } }, include: { organization: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 })
}

export async function readAccountNotification(userId: string, notificationId: string) {
  const updated = await prisma.accountNotification.updateMany({ where: { id: notificationId, userId, readAt: null }, data: { readAt: new Date() } })
  if (!updated.count) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено.')
}

export async function removeMember(actorUserId: string, organizationId: string, memberId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  assertCanRemoveMember(actor.role, target.role)
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.workShift.updateMany({ where: { organizationId, memberId: target.id, status: 'SCHEDULED', scheduledStartAt: { gt: now } }, data: { status: 'CANCELLED', cancelledAt: now, cancelledByMemberId: actor.id, cancellationReason: 'Сотрудник покинул организацию' } })
    await tx.organizationMember.update({ where: { id: target.id }, data: { leftAt: now } })
  }, { isolationLevel: 'Serializable' })
}
