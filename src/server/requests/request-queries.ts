import { Prisma } from '../../generated/prisma/client.ts'
import type { RequestDetail,RequestList } from '../../shared/requests.ts'
import { customRequestWhere } from '../access/request-policy.ts'
import { readRequestPage,requestInclude } from './request-read.ts'

import { hasPermission,locationsFor,requirePermission } from '../organizations/access/access.ts'
import { locationMemberWhere,locationWhere } from '../organizations/location-context.ts'
import { requireLocationManager } from '../organizations/location-service.ts'
import { stageReviewers } from './reviewers.ts'

import type { RequestStatus } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { addCalendarDays,startOfZonedDate } from '../schedule/timezone.ts'
import { reconcileShiftRequests } from './shift-conflicts.ts'

import { requestForAccess } from './request-access.ts'
import { conflictsFor } from './request-conflicts.ts'
import { absenceCodes,dateText,dateValue,type ListOptions } from './request-input.ts'
import { publicRequest } from './request-presenter.ts'

export async function listRequests(userId: string, organizationId: string, scope: 'mine' | 'incoming' | 'history' | 'staffing' | 'profile', options: ListOptions): Promise<RequestList> {
  const actor = await getMembership(userId, organizationId)
  const selfProfile = scope === 'profile' && options.memberId === actor.id
  if (scope === 'profile' && !options.memberId) throw new ApiError(400, 'MEMBER_REQUIRED', 'Выберите сотрудника.')
  if (scope === 'mine' || selfProfile) requirePermission(actor, 'requests.own')
  if (scope === 'staffing' && !hasPermission(actor, 'staffing.create')) requirePermission(actor, 'staffing.respond')
  if (!['mine', 'staffing'].includes(scope) && !selfProfile) requirePermission(actor, 'requests.view', options.pointId === 'all' ? undefined : options.pointId ?? actor.locationId)
  const pointScope = scope === 'staffing' ? { location: { archivedAt: null }, ...(options.pointId && options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : options.pointId ? { ...(scope === 'mine' || actor.organizationRole === 'OWNER' ? {} : { locationId: { in: locationsFor(actor, 'requests.view') } }), ...(options.pointId !== 'all' ? { locationId: options.pointId } : {}) } : locationWhere(organizationId)
  if (scope !== 'mine' && scope !== 'staffing' && options.pointId && options.pointId !== 'all') await requireLocationManager(prisma, userId, organizationId, options.pointId, 'requests.view')
  if (scope !== 'mine' && scope !== 'staffing' && !selfProfile && !options.pointId) requirePermission(actor, 'requests.view')
  await reconcileShiftRequests(organizationId)
  const selectedRole=options.roleId?await prisma.accessRole.findFirst({where:{organizationId,id:options.roleId},select:{systemCode:true}}):null
  const dateFilters: Prisma.OrganizationRequestWhereInput[] = []
  if (options.from || options.to) {
    const points = await prisma.organizationLocation.findMany({ where: { organizationId }, select: { id: true, timezone: true } })
    dateFilters.push({ OR: [
      { startDate: { ...(options.to ? { lte: dateValue(options.to)! } : {}) }, endDate: { ...(options.from ? { gte: dateValue(options.from)! } : {}) } },
      ...points.map(point => ({ locationId: point.id, proposedStartAt: { ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), point.timezone) } : { not: null }) }, proposedEndAt: { ...(options.from ? { gt: startOfZonedDate(options.from, point.timezone) } : { not: null }) } })),
      { startDate: null, proposedStartAt: null, createdAt: { ...(options.from ? { gte: startOfZonedDate(options.from, actor.organization.timezone) } : {}), ...(options.to ? { lt: startOfZonedDate(addCalendarDays(options.to, 1), actor.organization.timezone) } : {}) } },
    ] })
  }
  const where: Prisma.OrganizationRequestWhereInput = { organizationId, ...pointScope,
    ...(scope === 'profile' ? { createdByMemberId: options.memberId, status: options.status ?? (selfProfile ? undefined : { notIn: ['DRAFT', 'RETURNED'] }) } : scope === 'staffing' ? { systemCodeSnapshot: 'STAFFING', status: options.status ?? 'PENDING', proposedStartAt: { gt: new Date() } } : scope === 'mine' ? { OR:[{createdByMemberId:actor.id},{authorMemberId:actor.id},{outcome:{path:['assignees'],array_contains:[actor.id]}}], ...(options.status ? { status: options.status } : {}) } : scope === 'incoming' ? { status: 'PENDING' } : { status: options.status ? options.status : { in: ['APPROVED', 'REGISTERED', 'REJECTED', 'CANCELLED','EXPIRED','INVALID'] } }),
    ...(options.typeId ? { requestTypeId: options.typeId } : {}), ...(options.memberId && scope !== 'mine' ? { createdByMemberId: options.memberId } : {}),
    ...(options.roleId&&scope!=='mine'?{OR:[{creator:{accessRoleId:options.roleId}},...((options.pointId&&options.pointId!=='all')?[options.pointId]:locationsFor(actor,'requests.view')).map(locationId=>({locationId,creator:{OR:[{accessAssignments:{some:{locationId,roleId:options.roleId}}},...(selectedRole?.systemCode==='ADMIN'||selectedRole?.systemCode==='MEMBER'?[{accessConfigured:false,locationMemberships:{some:{locationId,leftAt:null,role:selectedRole.systemCode as 'ADMIN'|'MEMBER'}}}]:[])]}}))]}:options.role && scope !== 'mine' ? { creator: { role: options.role } } : {}),
    AND: [...dateFilters, ...(scope === 'profile' && !selfProfile ? [{ status: { notIn: ['DRAFT', 'RETURNED'] as RequestStatus[] } }] : []), ...(options.search ? options.search.trim().split(/\s+/).map((term) => ({ creator: { user: { OR: [{ email: { contains: term, mode: 'insensitive' as const } }, { firstName: { contains: term, mode: 'insensitive' as const } }, { lastName: { contains: term, mode: 'insensitive' as const } }, { middleName: { contains: term, mode: 'insensitive' as const } }] } } })) : [])],
  }
  if (!actor.owner && scope !== 'staffing') {
    const roles = await prisma.accessRole.findMany({ where: { organizationId }, select: { id: true, systemCode: true } })
    ;(where.AND as Prisma.OrganizationRequestWhereInput[]).push({ OR: [
      { systemCodeSnapshot: { not: null } }, customRequestWhere(actor, roles),
    ] })
  }
  const { total, rows } = await prisma.$transaction(tx => readRequestPage(tx, organizationId, where, options.page, options.pageSize), { isolationLevel: 'RepeatableRead' })
  const unread = scope === 'incoming' ? await prisma.organizationRequest.count({ where: { ...where, reads: { none: { memberId: actor.id } } } }) : 0
  return { requests: rows.map((item) => publicRequest(item, actor.id, actor)), pagination: { page: options.page, pageSize: options.pageSize, total, pages: Math.max(1, Math.ceil(total / options.pageSize)) }, counters: { pending: scope === 'incoming' ? total : 0, unread } }
}

export async function getRequest(userId: string, organizationId: string, requestId: string): Promise<RequestDetail> {
  const { actor, item } = await requestForAccess(userId, organizationId, requestId)
  if (hasPermission(actor, 'requests.view')) {
    const read = await prisma.requestRead.upsert({ where: { requestId_memberId: { requestId, memberId: actor.id } }, create: { requestId, memberId: actor.id }, update: {} })
    if (!item.reads.some((entry) => entry.memberId === actor.id)) item.reads.push(read)
  }
  const staffingResponses = item.systemCodeSnapshot === 'STAFFING' && hasPermission(actor, 'requests.view') ? (await prisma.organizationRequest.findMany({ where: { organizationId, staffingRequestId: item.id }, include: requestInclude, orderBy: { createdAt: 'asc' } })).map(response => publicRequest(response, actor.id, actor)) : []
  const resolveKey=item.systemCodeSnapshot==='VACATION'?'vacations.resolve':['STAFFING','STAFFING_RESPONSE'].includes(item.systemCodeSnapshot??'')?'staffing.resolve':'requests.resolve'
  const canReview=item.status==='PENDING'&&hasPermission(actor,resolveKey,item.locationId)&&(item.createdByMemberId!==actor.id||actor.owner||hasPermission(actor,'requests.selfResolve',item.locationId))&&((!item.systemCodeSnapshot||item.systemCodeSnapshot==='VACATION')?(await stageReviewers(prisma,item)).some(p=>p.id===actor.id):true)
  const ownResponse = item.systemCodeSnapshot === 'STAFFING' ? await prisma.organizationRequest.findFirst({ where: { staffingRequestId: item.id, createdByMemberId: actor.id, status:{in:['PENDING','APPROVED']} }, select: { id: true } }) : null
  const memberships = item.systemCodeSnapshot === 'STAFFING' ? await prisma.locationMember.findMany({ where: { memberId: actor.id, leftAt: null, location: { archivedAt: null } }, select: { locationId: true } }) : []
  return { staffingResponses, viewerResponseId: ownResponse?.id ?? null, viewerCanRespond: hasPermission(actor,'staffing.respond') && !!await prisma.requestType.findFirst({where:{organizationId,systemCode:'STAFFING_RESPONSE',isActive:true}}) && item.status === 'PENDING' && !!item.proposedStartAt && item.proposedStartAt > new Date() && !ownResponse && memberships.some(point => point.locationId !== item.locationId) && !memberships.some(point => point.locationId === item.locationId), request: { ...publicRequest(item, actor.id, actor), canReview, ...(!hasPermission(actor, 'requests.attachments') && item.createdByMemberId !== actor.id ? {attachments:[]} : {}), ...(!hasPermission(actor,'absences.details') && item.createdByMemberId !== actor.id ? {absenceReason:null} : {}) }, conflicts: (await conflictsFor(item, actor.organization.timezone)).filter(shift=>hasPermission(actor,item.createdByMemberId===actor.id?'schedule.own':'schedule.view',shift.locationId)).map(shift => ({...shift,scheduledStartAt:shift.scheduledStartAt.toISOString(),scheduledEndAt:shift.scheduledEndAt.toISOString()})), absenceConflicts: item.status === 'PENDING' && item.systemCodeSnapshot && absenceCodes.includes(item.systemCodeSnapshot) && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, memberId: item.createdByMemberId, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, select: { id: true, type: true, startDate: true, endDate: true } })).map(a => ({ ...a,type:item.createdByMemberId===actor.id||hasPermission(actor,'absences.details',item.locationId)?publicAbsenceType(a.type):'ABSENCE' as const, startDate: dateText(a.startDate)!, endDate: dateText(a.endDate)! })) : [], otherAbsentEmployees: hasPermission(actor, 'requests.view') && item.startDate && item.endDate ? (await prisma.employeeAbsence.findMany({ where: { organizationId, member: locationMemberWhere(organizationId), memberId: { not: item.createdByMemberId }, cancelledAt: null, startDate: { lte: item.endDate }, endDate: { gte: item.startDate } }, distinct: ['memberId'], select: { memberId: true } })).length : 0 }
}

function publicAbsenceType(value: string) { return value === 'VACATION' || value === 'DAY_OFF' || value === 'SICK' || value === 'SICK_LEAVE' ? value : 'ABSENCE' }
