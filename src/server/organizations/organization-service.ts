import { locationMemberWhere, scopedLocationId } from './location-context.ts'
import { listNotificationHistory } from './notification-service.ts'
import { onlineSessions } from '../profile/presence.ts'
import type { OrganizationRole, Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { deliverRoleChanged } from '../mail.ts'
import { assertCanChangeRole, assertCanRemoveMember, getMembership } from './permissions.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { seedSystemRequestTypes } from '../requests/service.ts'

export type CreateOrganizationInput = { name: string; description: string | null; timezone: string; firstLocation?: { name: string; city: string; address: string; timezone: string; teamNames?: string[] }; locations?: Array<{ name: string; city: string; address: string; timezone: string; teamNames?: string[] }> }
export type UpdateOrganizationInput = Pick<CreateOrganizationInput, 'name' | 'description' | 'timezone'> & { contactEmail: string | null; phone: string | null; website: string | null; address: string | null }

export async function createOrganization(userId: string, input: CreateOrganizationInput) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name: input.name, description: input.description, timezone: input.timezone, createdByUserId: userId } })
    const owner = await tx.organizationMember.create({ data: { organizationId: organization.id, userId, role: 'OWNER' } })
    const locationInputs = [input.firstLocation ?? { name: 'Основная точка', city: '', address: '', timezone: input.timezone }, ...(input.locations ?? [])]
    const locations = []
    for (const item of locationInputs) {
      const location = await tx.organizationLocation.create({ data: { name: item.name, city: item.city, address: item.address, timezone: item.timezone, organizationId: organization.id } })
      await tx.locationMember.create({ data: { organizationId: organization.id, locationId: location.id, memberId: owner.id } })
      if ('teamNames' in item && item.teamNames?.length) await tx.locationTeam.createMany({ data: [...new Set(item.teamNames.filter(Boolean))].map(name => ({ organizationId: organization.id, locationId: location.id, name })) })
      locations.push({ ...location, role: 'OWNER' as const })
    }
    await seedSystemRequestTypes(tx, organization.id)
    await tx.documentFolder.createMany({ data: [{ organizationId: organization.id, name: 'Главная' }, { organizationId: organization.id, name: 'Документы сотрудников' }] })
    return { ...organization, logoUrl: null, role: 'OWNER' as const, organizationRole: 'OWNER' as const, locations, locationId: locations[0].id, memberCount: 1 }
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
  const memberCount = await prisma.organizationMember.count({ where: { organizationId, ...locationMemberWhere(organizationId), leftAt: null, user: { deletedAt: null } } })
  return {
    id: membership.organization.id,
    name: membership.organization.name,
    description: membership.organization.description,
    timezone: membership.organization.timezone,
    role: membership.role,
    organizationRole: membership.organizationRole,
    viewerMemberId: membership.id,
    assignedToLocation: !!membership.assignedLocationId,
    organizationTimezone: (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })).timezone,
    locationId: membership.locationId,
    location: membership.location,
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
  if (membership.organizationRole !== 'OWNER') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Недостаточно прав для изменения организации.')
  return prisma.organization.update({ where: { id: organizationId }, data: input })
}

export async function listMembers(userId: string, organizationId: string) {
  await getMembership(userId, organizationId)
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, ...locationMemberWhere(organizationId), leftAt: null, organization: { deletedAt: null }, user: { deletedAt: null } },
    include: { locationMemberships: { where: { leftAt: null }, select: { locationId: true, role: true } }, teamMemberships: { include: { team: { select: { id: true, name: true, locationId: true } } } }, positions: { where: { position: { isActive: true } }, include: { position: { select: { id: true, name: true } } } }, user: { select: { id: true, email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, lastSeenAt: true, avatarFileId: true, sessions: { where: onlineSessions(), select: { id: true }, take: 1 } } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })
  return members.map((member) => {
    const displayName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || member.user.email.split('@')[0]
    return { positions: member.positions.map(item => item.position), id: member.id, userId: member.userId, email: member.user.email, displayName, firstName: member.user.firstName, lastName: member.user.lastName, middleName: member.user.middleName, phone: member.user.phone, bio: member.user.bio, avatarUrl: mediaUrl(member.user.avatarFileId), lastSeenAt: member.user.lastSeenAt, online: member.user.sessions.length > 0, role: member.role === 'OWNER' ? 'OWNER' : scopedLocationId(organizationId) ? member.locationMemberships.find(m => m.locationId === scopedLocationId(organizationId))?.role ?? 'MEMBER' : member.role, locations: member.locationMemberships, teams: member.teamMemberships.map(m => m.team), joinedAt: member.joinedAt }
  })
}

export async function listMembersPage(userId: string, organizationId: string, options: { directory?: string; pointId?: string; page?: number; pageSize?: number; role?: OrganizationRole; search?: string; positionId?: string }) {
  await getMembership(userId, organizationId)
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? 20
  const terms = options.search?.trim().split(/\s+/).filter(Boolean) ?? []
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId,
    ...(options.directory === 'true' ? { locationMemberships: { some: { leftAt: null, location: { archivedAt: null }, ...(options.pointId ? { locationId: options.pointId } : {}) } } } : locationMemberWhere(organizationId)),
    leftAt: null,
    organization: { deletedAt: null },
    user: { deletedAt: null },
    ...(options.role ? { role: options.role } : {}),
    ...(options.positionId ? { positions: options.positionId === 'unassigned' ? { none: { position: { isActive: true } } } : { some: { positionId: options.positionId, position: { organizationId, isActive: true } } } } : {}),
    ...(terms.length ? { NOT: { OR: terms.map((term) => ({ NOT: { user: { OR: [
      { email: { contains: term, mode: 'insensitive' } },
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { middleName: { contains: term, mode: 'insensitive' } },
    ] } } })) } } : {}),
  }
  const [total, members] = await prisma.$transaction([
    prisma.organizationMember.count({ where }),
    prisma.organizationMember.findMany({
      where,
      include: { locationMemberships: { where: { leftAt: null }, select: { locationId: true, role: true } }, teamMemberships: { include: { team: { select: { id: true, name: true, locationId: true } } } }, positions: { where: { position: { isActive: true } }, include: { position: { select: { id: true, name: true } } } }, user: { select: { id: true, email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, lastSeenAt: true, avatarFileId: true, sessions: { where: onlineSessions(), select: { id: true }, take: 1 } } } },
      orderBy: [{ role: 'asc' }, { user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { user: { email: 'asc' } }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    members: members.map((member) => {
      const displayName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || member.user.email.split('@')[0]
      return { positions: member.positions.map(item => item.position), id: member.id, userId: member.userId, email: member.user.email, displayName, firstName: member.user.firstName, lastName: member.user.lastName, middleName: member.user.middleName, phone: member.user.phone, bio: member.user.bio, avatarUrl: mediaUrl(member.user.avatarFileId), lastSeenAt: member.user.lastSeenAt, online: member.user.sessions.length > 0, role: member.role, locations: member.locationMemberships, teams: member.teamMemberships.map(m => m.team), joinedAt: member.joinedAt }
    }),
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
  }
}

export async function changeMemberRole(actorUserId: string, organizationId: string, memberId: string, nextRole: Exclude<OrganizationRole, 'OWNER'>) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null }, include: { user: true } })
  if (!target || target.user.deletedAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  if (actor.organizationRole !== 'OWNER') throw new ApiError(403, 'OWNER_REQUIRED', 'Роли назначает владелец.')
  assertCanChangeRole(actor.role, target.role)
  if (target.role === nextRole) return target
  const roleName = nextRole === 'ADMIN' ? 'Администратор' : 'Пользователь'
  const member = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const currentActor = await tx.organizationMember.findFirst({ where: { id: actor.id, organizationId, leftAt: null, organization: { deletedAt: null } } })
    if (currentActor?.role !== 'OWNER') throw new ApiError(403, 'OWNER_REQUIRED', 'Роли назначает владелец.')
    const currentTarget = await tx.organizationMember.findFirst({ where: { id: target.id, organizationId, leftAt: null, user: { deletedAt: null } } })
    if (!currentTarget) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
    assertCanChangeRole(currentActor.role, currentTarget.role)
    await tx.locationMember.updateMany({ where: { organizationId, memberId: target.id, leftAt: null }, data: { role: nextRole } })
    const updated = await tx.organizationMember.update({ where: { id: target.id }, data: { role: nextRole } })
    if (nextRole === 'MEMBER') await tx.documentAcknowledgement.updateMany({ where: { memberId: target.id, acknowledgedAt: null, cancelledAt: null, document: { organizationId, OR: [{ visibility: 'ADMINS' }, { visibility: 'PRIVATE_MEMBER', targetMemberId: { not: target.id } }] } }, data: { cancelledAt: new Date() } })
    await tx.accountNotification.create({ data: { userId: target.userId, organizationId, type: 'ROLE_CHANGED', title: 'Роль изменена', message: `В организации «${actor.organization.name}» вам назначена роль «${roleName}».` } })
    return updated
  })
  void deliverRoleChanged(target.user.email, actor.organization.name, roleName).catch((error) => console.error('Role-changed email failed:', error))
  return member
}

export async function listAccountNotifications(userId: string, organizationId?: string) {
  if (organizationId) await getMembership(userId, organizationId)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!user) return []
  const history = await listNotificationHistory(userId, user.email, { limit: 50, unread: true, organizationId, locationId: organizationId ? scopedLocationId(organizationId) : undefined })
  return history.notifications.filter(item => item.source === 'event' && !['SHIFT_ASSIGNED', 'SHIFT_CHANGED', 'SHIFT_CANCELLED', 'DOCUMENT_ASSIGNED'].includes(item.type)).map(item => ({ ...item, id: item.id.slice('event:'.length), organizationId: item.organization.id }))
}

export async function readAccountNotification(userId: string, notificationId: string) {
  const updated = await prisma.accountNotification.updateMany({ where: { id: notificationId, userId, hiddenAt: null, organization: { deletedAt: null, members: { some: { userId, leftAt: null } } } }, data: { readAt: new Date() } })
  if (!updated.count) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено.')
}

export async function removeMember(actorUserId: string, organizationId: string, memberId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  assertCanRemoveMember(actor.role, target.role)
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    await tx.documentAcknowledgement.updateMany({ where: { memberId: target.id, acknowledgedAt: null, cancelledAt: null, document: { organizationId } }, data: { cancelledAt: now } })
    await tx.workShift.updateMany({ where: { organizationId, memberId: target.id, status: 'SCHEDULED', scheduledStartAt: { gt: now } }, data: { status: 'CANCELLED', cancelledAt: now, cancelledByMemberId: actor.id, cancellationReason: 'Сотрудник покинул организацию' } })
    await tx.locationMember.updateMany({ where: { memberId: target.id, organizationId, leftAt: null }, data: { leftAt: now } })
    await tx.locationTeamMember.deleteMany({ where: { memberId: target.id, organizationId } })
    await tx.organizationMember.update({ where: { id: target.id }, data: { leftAt: now } })
    const pending = await tx.organizationRequest.findMany({ where: { organizationId, createdByMemberId: target.id, status: 'PENDING' }, select: { id: true } })
    if (pending.length) {
      const ids = pending.map((request) => request.id)
      await tx.organizationRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', cancelledAt: now, resolutionComment: 'Участник покинул организацию' } })
      await tx.requestEvent.createMany({ data: ids.map((requestId) => ({ requestId, actorMemberId: actor.id, type: 'CANCELLED' as const, comment: 'Участник покинул организацию' })) })
      await tx.accountNotification.updateMany({ where: { requestId: { in: ids }, readAt: null }, data: { readAt: now } })
    }
  }, { isolationLevel: 'Serializable' })
}
