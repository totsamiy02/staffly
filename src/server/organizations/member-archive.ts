import { startOfZonedDate, addCalendarDays } from '../schedule/timezone.ts'
import { prisma } from '../db.ts'
import type { Prisma } from '../../generated/prisma/client.ts'
import { getMembership } from './access/permissions.ts'
import { hasPermission, locationsFor, requirePermission } from './access/access.ts'
import { ApiError } from '../api-error.ts'
import { memberFieldVisible } from './organization-service.ts'

export type ArchiveOptions = { page: number; pageSize: number; search?: string; pointId?: string; departedFrom?: Date|string; departedTo?: Date|string }
export async function listFormerMembers(userId: string, organizationId: string, options: ArchiveOptions) {
  return prisma.$transaction(async db => {
    const actor = await getMembership(userId, organizationId, db)
    requirePermission(actor, 'members.view')
    requirePermission(actor, 'members.remove')
    const points = actor.owner ? undefined : locationsFor(actor, 'members.remove').filter(id => hasPermission(actor, 'members.view', id))
    if (options.pointId && !actor.owner && !points?.includes(options.pointId)) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Архив этой точки недоступен.')
    if (options.pointId && !await db.organizationLocation.findFirst({ where: { id: options.pointId, organizationId } })) throw new ApiError(404, 'LOCATION_NOT_FOUND', 'Точка не найдена.')
    const scope = options.pointId ? [options.pointId] : points
    const departedFrom=typeof options.departedFrom==='string'?startOfZonedDate(options.departedFrom,actor.organization.timezone):options.departedFrom
    const departedTo=typeof options.departedTo==='string'?startOfZonedDate(addCalendarDays(options.departedTo,1),actor.organization.timezone):options.departedTo
    const terms = options.search?.split(/\s+/).filter(Boolean) ?? []
    const contactPoints=actor.owner?[]:(scope??[]).filter(id=>hasPermission(actor,'members.contacts',id))
    const where: Prisma.OrganizationMemberWhereInput = {
      organizationId, leftAt: { not: null, ...(departedFrom ? { gte: departedFrom } : {}), ...(departedTo ? { lt: departedTo } : {}) }, user: { deletedAt: null },
      ...(scope ? { locationMemberships: { some: { locationId: { in: scope } } } } : {}),
      AND: terms.map(term => ({ OR: [{user:{OR:['firstName','lastName','middleName'].map(field=>({[field]:{contains:term,mode:'insensitive'}}))}},...(actor.owner||contactPoints.length?[{user:{email:{contains:term,mode:'insensitive' as const}},...(!actor.owner?{locationMemberships:{some:{locationId:{in:contactPoints}}}}:{})}]:[])] })),
    }
    const [total, rows] = await Promise.all([db.organizationMember.count({ where }), db.organizationMember.findMany({ where, orderBy: [{ leftAt: 'desc' }, { id: 'asc' }], skip: (options.page-1)*options.pageSize, take: options.pageSize, include: {
      user: { select: { firstName:true,lastName:true,middleName:true,email:true } },
      accessAssignments: { select: { locationId:true } },
      employmentPeriods: { orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] },
      locationMemberships: { where: scope ? { locationId: { in: scope } } : {}, select: { locationId: true, location: { select: { name: true } } } },
    } })])
    const current=await getMembership(userId,organizationId,db)
    const signature=(value:typeof actor)=>JSON.stringify([value.owner,...(['members.view','members.remove','members.contacts'] as const).map(key=>[hasPermission(value,key),[...locationsFor(value,key)].sort()])])
    if(signature(current)!==signature(actor))throw new ApiError(403,'INSUFFICIENT_PERMISSIONS','Права изменились. Обновите архив сотрудников.')
    return { members: rows.map(member => ({ id: member.id, displayName: [member.user.lastName,member.user.firstName,member.user.middleName].filter(Boolean).join(' ') || (memberFieldVisible(actor,member,'members.contacts') ? member.user.email.split('@')[0] : 'Бывший сотрудник'), email: memberFieldVisible(actor,member,'members.contacts') ? member.user.email : '', joinedAt: member.joinedAt, leftAt: member.leftAt!, periods: member.employmentPeriods.map(p => ({ id:p.id,startedAt:p.startedAt,endedAt:p.endedAt,incomplete:p.source==='LEGACY' })), locations: member.locationMemberships.map(l => ({ id:l.locationId,name:l.location.name })) })), pagination: { page:options.page,pageSize:options.pageSize,total,pages:Math.max(1,Math.ceil(total/options.pageSize)) } }
  })
}
