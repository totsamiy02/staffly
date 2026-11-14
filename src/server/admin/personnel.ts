import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { personnelRecord, loadPersonnelHistory } from '../organizations/member-personnel-service.ts'
import type { Prisma } from '../../generated/prisma/client.ts'

const include = {
  organization: { select: { id: true, name: true, logoFileId: true } },
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  teamMemberships: { include: { team: { select: { name: true } } } },
  positions: { where: { position: { isActive: true } }, include: { position: { select: { name: true } } } },
  locationMemberships: { include: { location: { select: { name: true } } } },
  employmentPeriods: { orderBy: [{ startedAt: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.OrganizationMemberInclude
export const adminPersonnelInclude = include

export function adminPersonnelDto(member: Prisma.OrganizationMemberGetPayload<{ include: typeof include }>) {
  return {
    id: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    accountName: [member.user.lastName, member.user.firstName].filter(Boolean).join(' ')
      || member.user.email.split('@')[0] || 'Пользователь',
    organizationName: member.organization.name,
    leftAt: member.leftAt,
    role: member.role,
    record: personnelRecord(member),
    teams: member.teamMemberships.map(item => item.team.name),
    positions: member.positions.map(item => item.position.name),
    locations: member.locationMemberships.filter(point => member.leftAt || !point.leftAt).map(point => point.location.name),
    periods: member.employmentPeriods.map(period => ({
      startedAt: period.startedAt,
      endedAt: period.endedAt,
      incomplete: period.source === 'LEGACY',
    })),
  }
}

// These read-only functions use the existing PIN-protected admin read wrapper.
export async function adminOrganizationPersonnel(id: string, raw: unknown) {
  const { page, search } = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    search: z.string().trim().max(120).default(''),
  }).parse(raw)
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId: id,
    organization: { deletedAt: null },
    user: { deletedAt: null },
    AND: search.split(/\s+/).filter(Boolean).map(term => ({
      OR: [
        { personnelNumber: { contains: term, mode: 'insensitive' } },
        { personnelFirstName: { contains: term, mode: 'insensitive' } },
        { personnelLastName: { contains: term, mode: 'insensitive' } },
        { workEmail: { contains: term, mode: 'insensitive' } },
        { user: { OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
        ] } },
      ],
    })),
  }
  const organization = await prisma.organization.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  if (!organization) throw new ApiError(404, 'ADMIN_ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  const [total, rows] = await prisma.$transaction([
    prisma.organizationMember.count({ where }),
    prisma.organizationMember.findMany({ where, include, orderBy: [{ joinedAt: 'desc' }, { id: 'asc' }], take: 20, skip: (page - 1) * 20 }),
  ])
  return { items: rows.map(adminPersonnelDto), total, page, pageSize: 20 }
}

export async function adminPersonnelHistory(organizationId: string, memberId: string, raw: unknown) {
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(raw)
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId, organization: { deletedAt: null }, user: { deletedAt: null } },
    select: { id: true },
  })
  if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  return loadPersonnelHistory(prisma, organizationId, memberId, page)
}
