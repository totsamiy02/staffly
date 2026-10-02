import { date } from '../schedule/schemas.ts'
import { zonedDateTimeToUtc } from '../schedule/timezone.ts'
import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership, requireOrganizationRole } from './permissions.ts'
import { locationBody } from './schemas.ts'
import { scopedLocationId } from './location-context.ts'

export const teamBody = z.object({ name: z.string().trim().min(2).max(120), memberIds: z.array(z.uuid()).max(500).default([]) })
export const locationMemberBody = z.object({ memberId: z.uuid(), role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER') })
export const transferBody = z.object({ memberId: z.uuid(), fromLocationId: z.uuid(), toLocationId: z.uuid(), temporary: z.boolean(), startAt: z.iso.datetime().optional(), endAt: z.iso.datetime().optional(), startDate: date.optional(), endDate: date.optional(), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(), endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional() }).superRefine((v, ctx) => {
  if (v.fromLocationId === v.toLocationId) ctx.addIssue({ code: 'custom', message: 'Выберите другую точку.' })
  if (v.temporary && !(v.startAt && v.endAt && Date.parse(v.endAt) > Date.parse(v.startAt)) && !(v.startDate && v.endDate && v.startTime && v.endTime)) ctx.addIssue({ code: 'custom', message: 'Укажите начало и окончание подмены.' })
})

async function lock(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
}
async function actorIn(tx: Prisma.TransactionClient, userId: string, organizationId: string) {
  const actor = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } }, include: { organization: true } })
  if (!actor || actor.leftAt || actor.organization.deletedAt) throw new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'Организация не найдена.')
  return actor
}
export async function requireLocationManager(tx: Prisma.TransactionClient | typeof prisma, userId: string, organizationId: string, locationId: string) {
  const location = await tx.organizationLocation.findFirst({ where: { id: locationId, organizationId, archivedAt: null } })
  const actor = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } }, include: { organization: true } })
  if (!location || !actor || actor.leftAt || actor.organization.deletedAt) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
  const membership = await tx.locationMember.findUnique({ where: { locationId_memberId: { locationId, memberId: actor.id } } })
  if (actor.role !== 'OWNER' && (!membership || membership.leftAt || membership.role !== 'ADMIN')) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Нужны права администратора этой точки или владельца.')
  return actor
}
export async function listLocations(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  const locations = await prisma.organizationLocation.findMany({ where: { organizationId, ...(actor.organizationRole === 'OWNER' ? {} : { archivedAt: null }) }, include: { members: { where: { memberId: actor.id, leftAt: null } }, _count: { select: { members: { where: { leftAt: null, member: { leftAt: null } } } } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return locations.map(({ members, _count, ...item }) => ({ ...item, role: actor.organizationRole === 'OWNER' ? 'OWNER' : members[0]?.role ?? 'MEMBER', memberCount: _count.members }))
}
export async function saveLocation(userId: string, organizationId: string, locationId: string | null, input: z.infer<typeof locationBody>) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const actor = await actorIn(tx, userId, organizationId)
    requireOrganizationRole(actor.role, ['OWNER'])
    if (locationId && !await tx.organizationLocation.findFirst({ where: { id: locationId, organizationId, archivedAt: null } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
    const { teamNames, ...metadata } = input
    const location = locationId ? await tx.organizationLocation.update({ where: { id: locationId }, data: metadata }) : await tx.organizationLocation.create({ data: { ...metadata, organizationId } })
    if (!locationId && (teamNames ?? []).length) await tx.locationTeam.createMany({ data: (teamNames ?? []).map(name => ({ organizationId, locationId: location.id, name })) })
    if (!locationId) await tx.locationMember.create({ data: { organizationId, locationId: location.id, memberId: actor.id } })
    return location
  })
}
export async function archiveLocation(userId: string, organizationId: string, locationId: string) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const actor = await actorIn(tx, userId, organizationId); requireOrganizationRole(actor.role, ['OWNER'])
    if (!await tx.organizationLocation.findFirst({ where: { id: locationId, organizationId, archivedAt: null } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
    if (await tx.organizationLocation.count({ where: { organizationId, archivedAt: null } }) <= 1) throw new ApiError(409, 'LAST_LOCATION', 'Последнюю действующую точку нельзя закрыть.')
    if (await tx.workShift.count({ where: { locationId, status: 'SCHEDULED', scheduledEndAt: { gt: new Date() } } }) || await tx.organizationRequest.count({ where: { locationId, status: 'PENDING' } }) || await tx.locationTransfer.count({ where: { temporary: true, endAt: { gt: new Date() }, OR: [{ fromLocationId: locationId }, { toLocationId: locationId }] } })) throw new ApiError(409, 'LOCATION_HAS_WORK', 'Сначала обработайте заявки, будущие смены и подмены этой точки.')
    await tx.organizationInvite.updateMany({ where: { locationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
    return tx.organizationLocation.update({ where: { id: locationId }, data: { archivedAt: new Date() } })
  })
}
export async function assignLocationMember(userId: string, organizationId: string, locationId: string, memberId: string, role: 'ADMIN' | 'MEMBER') {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const actor = await requireLocationManager(tx, userId, organizationId, locationId)
    const member = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, leftAt: null, user: { deletedAt: null } } })
    if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
    const old = await tx.locationMember.findUnique({ where: { locationId_memberId: { locationId, memberId } } })
    if ((role === 'ADMIN' || old?.role === 'ADMIN') && actor.role !== 'OWNER') throw new ApiError(403, 'OWNER_REQUIRED', 'Администраторов назначает и снимает владелец.')
    if (old?.role === 'ADMIN' && role === 'MEMBER') await tx.documentAcknowledgement.updateMany({ where: { memberId, acknowledgedAt: null, cancelledAt: null, document: { organizationId, locationId, visibility: 'ADMINS' } }, data: { cancelledAt: new Date() } })
    return tx.locationMember.upsert({ where: { locationId_memberId: { locationId, memberId } }, create: { organizationId, locationId, memberId, role }, update: { role, leftAt: null } })
  })
}
export async function removeLocationMember(userId: string, organizationId: string, locationId: string, memberId: string) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const actor = await requireLocationManager(tx, userId, organizationId, locationId)
    const target = await tx.locationMember.findUnique({ where: { locationId_memberId: { locationId, memberId } }, include: { member: true } })
    if (!target || target.leftAt || target.member.leftAt) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
    if (target.member.role === 'OWNER' || (actor.role !== 'OWNER' && target.role === 'ADMIN')) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Этого участника нельзя убрать из точки.')
    await tx.locationTeamMember.deleteMany({ where: { memberId, team: { locationId } } })
    await tx.locationMember.update({ where: { locationId_memberId: { locationId, memberId } }, data: { leftAt: new Date() } })
    // Removing a point assignment does not end organization membership or rewrite shifts.
  })
}
export async function listTeams(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  return prisma.locationTeam.findMany({ where: { organizationId, locationId: actor.locationId }, include: { members: { select: { memberId: true } } }, orderBy: { name: 'asc' } })
}
export async function saveTeam(userId: string, organizationId: string, teamId: string | null, input: z.infer<typeof teamBody>) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const locationId = scopedLocationId(organizationId) ?? (await getMembership(userId, organizationId)).locationId
    await requireLocationManager(tx, userId, organizationId, locationId)
    if (teamId && !await tx.locationTeam.findFirst({ where: { id: teamId, organizationId, locationId } })) throw new ApiError(404, 'TEAM_NOT_FOUND', 'Команда не найдена.')
    const ids = [...new Set(input.memberIds)]
    if (await tx.locationMember.count({ where: { locationId, memberId: { in: ids }, leftAt: null, member: { leftAt: null } } }) !== ids.length) throw new ApiError(400, 'TEAM_MEMBERS_INVALID', 'Выберите постоянных сотрудников этой точки.')
    const team = teamId ? await tx.locationTeam.update({ where: { id: teamId }, data: { name: input.name } }) : await tx.locationTeam.create({ data: { organizationId, locationId, name: input.name } })
    await tx.locationTeamMember.deleteMany({ where: { teamId: team.id } })
    if (ids.length) await tx.locationTeamMember.createMany({ data: ids.map(memberId => ({ organizationId, teamId: team.id, memberId })) })
    return team
  }).catch(error => { if (error?.code === 'P2002') throw new ApiError(409, 'TEAM_DUPLICATE', 'Команда с таким названием уже существует.'); throw error })
}
export async function deleteTeam(userId: string, organizationId: string, teamId: string) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const locationId = scopedLocationId(organizationId) ?? (await getMembership(userId, organizationId)).locationId
    await requireLocationManager(tx, userId, organizationId, locationId)
    const team = await tx.locationTeam.findFirst({ where: { id: teamId, organizationId, locationId } })
    if (!team) throw new ApiError(404, 'TEAM_NOT_FOUND', 'Команда не найдена.')
    await tx.locationTeam.delete({ where: { id: teamId } })
  })
}
export async function transferMember(userId: string, organizationId: string, input: z.infer<typeof transferBody>) {
  return prisma.$transaction(async tx => {
    await lock(tx, organizationId)
    const actor = await requireLocationManager(tx, userId, organizationId, input.fromLocationId)
    await requireLocationManager(tx, userId, organizationId, input.toLocationId)
    const source = await tx.locationMember.findUnique({ where: { locationId_memberId: { locationId: input.fromLocationId, memberId: input.memberId } }, include: { member: true } })
    if (!source || source.leftAt || source.member.leftAt || source.organizationId !== organizationId) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не состоит в исходной точке.')
    if (source.member.role === 'OWNER' || (source.role === 'ADMIN' && actor.role !== 'OWNER')) throw new ApiError(403, 'OWNER_REQUIRED', 'Перевод администратора оформляет владелец.')
    const sourceLocation = await tx.organizationLocation.findUniqueOrThrow({ where: { id: input.fromLocationId } })
    const startAt = input.temporary ? input.startAt ? new Date(input.startAt) : zonedDateTimeToUtc(input.startDate!, input.startTime!, sourceLocation.timezone) : new Date()
    const endAt = input.temporary ? input.endAt ? new Date(input.endAt) : zonedDateTimeToUtc(input.endDate!, input.endTime!, sourceLocation.timezone) : null
    if (endAt && endAt <= startAt) throw new ApiError(400, 'INVALID_TRANSFER_PERIOD', 'Окончание подмены должно быть позже начала.')
    if (endAt && endAt <= new Date()) throw new ApiError(400, 'TRANSFER_PAST', 'Период подмены уже закончился.')
    const transfer = await tx.locationTransfer.create({ data: { organizationId, memberId: input.memberId, createdByMemberId: actor.id, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, temporary: input.temporary, startAt, endAt } })
    if (!input.temporary) {
      await tx.locationMember.upsert({ where: { locationId_memberId: { locationId: input.toLocationId, memberId: input.memberId } }, create: { organizationId, locationId: input.toLocationId, memberId: input.memberId }, update: { leftAt: null } })
      await tx.locationMember.update({ where: { locationId_memberId: { locationId: input.fromLocationId, memberId: input.memberId } }, data: { leftAt: new Date() } })
      await tx.locationTeamMember.deleteMany({ where: { memberId: input.memberId, team: { locationId: input.fromLocationId } } })
    }
    await tx.accountNotification.create({ data: { organizationId, userId: source.member.userId, type: 'ROLE_CHANGED', title: input.temporary ? 'Назначена подмена' : 'Перевод в другую точку', message: 'Изменено распределение по точкам. Уже назначенные смены сохранены.' } })
    return transfer
  })
}
