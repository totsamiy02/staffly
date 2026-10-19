import { hasPermission, requirePermission } from '../../organizations/access/access.ts'
import { locationWhere, locationMemberWhere, scopedLocationId } from '../../organizations/location-context.ts'
import { z } from 'zod'
import { prisma } from '../../db.ts'
import { ApiError } from '../../api-error.ts'
import { getMembership } from '../../organizations/access/permissions.ts'

export const positionBody = z.object({ name: z.string().trim().min(2).max(120), isActive: z.boolean().default(true) })
export const templateBody = positionBody.extend({ positionId: z.string().uuid().nullable(), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), endDayOffset: z.number().int().min(0).max(1) }).refine(v => v.endDayOffset === 1 || v.endTime > v.startTime, 'Окончание должно быть позже начала.')
export const workloadBody = z.object({ monthlyWorkMinutes: z.number().int().min(60).max(44_640).nullable() })
export const assignmentBody = z.object({ positionIds: z.array(z.string().uuid()).max(20) })

export async function planningData(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  const [positions, templates, assignments] = await Promise.all([
    prisma.organizationPosition.findMany({ where: { organizationId }, orderBy: { name: 'asc' } }),
    prisma.shiftTemplate.findMany({ where: { organizationId, ...locationWhere(organizationId) }, orderBy: { name: 'asc' } }),
    prisma.memberPosition.findMany({ where: { member: { organizationId, ...locationMemberWhere(organizationId), leftAt: null } } }),
  ])
  const schedule = hasPermission(actor,'schedule.view') || hasPermission(actor,'schedule.own') || hasPermission(actor,'schedule.templates')
  const directory = hasPermission(actor,'members.view') || hasPermission(actor,'members.positions')
  const canSeePositions = schedule || directory || hasPermission(actor,'coverage.view') || hasPermission(actor,'positions.manage',null) || (['requests.create','staffing.create','staffing.respond','offers.accept','statistics.view','statistics.own'] as const).some(key=>actor.permissions.includes(key))
  return { positions:canSeePositions ? positions : [], templates:schedule ? templates : [], assignments:schedule || directory ? assignments.filter(a=>directory || hasPermission(actor,'schedule.view') || a.memberId===actor.id) : [], monthlyWorkMinutes:schedule || hasPermission(actor,'schedule.settings') || hasPermission(actor,'statistics.own') || hasPermission(actor,'statistics.view') ? actor.organization.monthlyWorkMinutes : null }
}
export async function savePosition(userId: string, organizationId: string, id: string | null, input: z.infer<typeof positionBody>) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'positions.manage', null)
  if (id && !await prisma.organizationPosition.findFirst({ where: { id, organizationId } })) throw new ApiError(404, 'POSITION_NOT_FOUND', 'Должность не найдена.')
  try { return id ? await prisma.organizationPosition.update({ where: { id }, data: input }) : await prisma.organizationPosition.create({ data: { ...input, organizationId } }) }
  catch (error) { if ((error as { code?: string }).code === 'P2002') throw new ApiError(409, 'POSITION_DUPLICATE', 'Такая должность уже существует.'); throw error }
}
export async function saveTemplate(userId: string, organizationId: string, id: string | null, input: z.infer<typeof templateBody>) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'schedule.templates')
  if (id && !await prisma.shiftTemplate.findFirst({ where: { id, organizationId, ...locationWhere(organizationId) } })) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Шаблон не найден.')
  if (input.positionId && !await prisma.organizationPosition.findFirst({ where: { id: input.positionId, organizationId, ...(input.isActive ? { isActive: true } : {}) } })) throw new ApiError(400, 'POSITION_INACTIVE', 'Выберите активную должность организации.')
  return id ? prisma.shiftTemplate.update({ where: { id }, data: input }) : prisma.shiftTemplate.create({ data: { ...input, organizationId, locationId: actor.locationId } })
}
export async function assignPositions(userId: string, organizationId: string, memberId: string, positionIds: string[]) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'members.positions')
  return prisma.$transaction(async tx => {
    if (!await tx.organizationMember.findFirst({ where: { id: memberId, organizationId, ...locationMemberWhere(organizationId), leftAt: null } })) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
    const ids = [...new Set(positionIds)]
    if (await tx.organizationPosition.count({ where: { id: { in: ids }, organizationId, isActive: true } }) !== ids.length) throw new ApiError(400, 'POSITION_INACTIVE', 'Выберите активные должности организации.')
    await tx.memberPosition.deleteMany({ where: { memberId } })
    if (ids.length) await tx.memberPosition.createMany({ data: ids.map(positionId => ({ memberId, positionId })) })
  }, { isolationLevel: 'Serializable' })
}
export async function saveWorkload(userId: string, organizationId: string, monthlyWorkMinutes: number | null) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'schedule.settings')
  if (scopedLocationId(organizationId)) return prisma.organizationLocation.update({ where: { id: actor.locationId }, data: { monthlyWorkMinutes } })
  return prisma.organization.update({ where: { id: organizationId }, data: { monthlyWorkMinutes } })
}
