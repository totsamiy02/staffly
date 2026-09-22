import type { OrganizationRole } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { assertCanChangeRole, assertCanRemoveMember, getMembership } from './permissions.ts'

export type CreateOrganizationInput = { name: string; description: string | null; timezone: string }

export async function createOrganization(userId: string, input: CreateOrganizationInput) {
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { ...input, createdByUserId: userId } })
    await tx.organizationMember.create({ data: { organizationId: organization.id, userId, role: 'OWNER' } })
    return { ...organization, role: 'OWNER' as const, memberCount: 1 }
  })
}

export async function listOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, organization: { deletedAt: null } },
    include: { organization: { include: { _count: { select: { members: true } } } } },
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
  }))
}

export async function getOrganization(userId: string, organizationId: string) {
  const membership = await getMembership(userId, organizationId)
  const memberCount = await prisma.organizationMember.count({ where: { organizationId, user: { deletedAt: null } } })
  return {
    id: membership.organization.id,
    name: membership.organization.name,
    description: membership.organization.description,
    timezone: membership.organization.timezone,
    role: membership.role,
    memberCount,
  }
}

export async function listMembers(userId: string, organizationId: string) {
  await getMembership(userId, organizationId)
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, organization: { deletedAt: null }, user: { deletedAt: null } },
    include: { user: { select: { id: true, email: true } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })
  return members.map((member) => ({ id: member.id, userId: member.userId, email: member.user.email, displayName: member.user.email.split('@')[0], role: member.role, joinedAt: member.joinedAt }))
}

export async function changeMemberRole(actorUserId: string, organizationId: string, memberId: string, nextRole: Exclude<OrganizationRole, 'OWNER'>) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId }, include: { user: true } })
  if (!target || target.user.deletedAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  assertCanChangeRole(actor.role, target.role)
  if (target.role === nextRole) return target
  return prisma.organizationMember.update({ where: { id: target.id }, data: { role: nextRole } })
}

export async function removeMember(actorUserId: string, organizationId: string, memberId: string) {
  const actor = await getMembership(actorUserId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { id: memberId, organizationId } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Участник не найден.')
  assertCanRemoveMember(actor.role, target.role)
  await prisma.organizationMember.delete({ where: { id: target.id } })
}
