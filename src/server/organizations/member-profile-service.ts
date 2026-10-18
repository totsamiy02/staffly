import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from './permissions.ts'
import { hasPermission, requirePermission, locationsFor } from './access.ts'
import { memberFieldVisible } from './organization-service.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { onlineSessions } from '../profile/presence.ts'
import { memberStatistics } from '../schedule/statistics.ts'
import { startOfZonedDate, zonedParts } from '../schedule/timezone.ts'
import { listMemberProfileDocuments } from '../documents/service.ts'
import { listRequests } from '../requests/service.ts'

export type MemberProfileOptions = { month: string; page: number; section: 'overview' | 'time' | 'documents' | 'requests'; kind: 'personal' | 'acknowledgements'; requestState: 'all' | 'pending' }
export async function memberProfile(userId: string, organizationId: string, memberId: string, options: MemberProfileOptions) {
  const actor = await getMembership(userId, organizationId)
  const target = await prisma.organizationMember.findFirst({ where: { organizationId, id: memberId, user: { deletedAt: null } }, include: {
    user: { select: { email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, avatarFileId: true, lastSeenAt: true, sessions: { where: onlineSessions(), select: { id: true }, take: 1 } } },
    locationTransfers: { where: { toLocationId: actor.locationId, temporary: true, revokedAt: null, endAt: { gt: new Date() } }, select: { id: true }, take: 1 },
    accessRole: { select: { name: true } }, accessAssignments: { include: { role: { select: { name: true } } } },
    positions: { where: { position: { isActive: true } }, include: { position: { select: { id: true, name: true } } } },
    locationMemberships: { where: { leftAt: null, location: { archivedAt: null } }, include: { location: { select: { id: true, name: true, timezone: true } } } },
  } })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник не найден.')
  const own = actor.id === target.id
  const workingInPoint = target.locationMemberships.some(item => item.locationId === actor.locationId) || target.locationTransfers.length > 0
  const targetInPoint = target.role === 'OWNER' || !!target.accessRoleId || workingInPoint || target.accessAssignments.some(item => item.locationId === actor.locationId)
  const historical = !targetInPoint && await prisma.workShift.count({ where: { organizationId, memberId, locationId: actor.locationId } }) > 0
  if (!own) {
    requirePermission(actor, 'members.view')
    if (!targetInPoint && !historical) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник недоступен в этой точке.')
  }
  const capabilities = {
    time: hasPermission(actor, own ? 'statistics.own' : 'statistics.view'),
    schedule: hasPermission(actor, own ? 'schedule.own' : 'schedule.view'),
    documents: hasPermission(actor, 'documents.view') && (own || hasPermission(actor, 'documents.personal.view') || hasPermission(actor, 'documents.control')),
    personalDocuments: hasPermission(actor, 'documents.view') && (own || hasPermission(actor, 'documents.personal.view')),
    acknowledgements: hasPermission(actor, 'documents.view') && (own || hasPermission(actor, 'documents.control')),
    requests: hasPermission(actor, own ? 'requests.own' : 'requests.view'),
    absences: hasPermission(actor, own ? 'absences.own' : 'absences.view'),
    correctTime: hasPermission(actor, 'schedule.actual'),
    managePositions: !target.leftAt && workingInPoint && hasPermission(actor, 'members.positions'),
    manageAccess: !target.leftAt && actor.owner,
  }
  const permittedPoints = actor.owner ? target.locationMemberships : target.locationMemberships.filter(item => own || locationsFor(actor, 'members.view').includes(item.locationId))
  const member = {
    id: target.id, userId: target.userId, firstName: target.user.firstName, lastName: target.user.lastName, middleName: target.user.middleName, displayName: [target.user.lastName, target.user.firstName, target.user.middleName].filter(Boolean).join(' ') || ((own || memberFieldVisible(actor, target, 'members.contacts')) ? target.user.email.split('@')[0] : 'Сотрудник'),
    email: (own || memberFieldVisible(actor, target, 'members.contacts')) ? target.user.email : '', phone: (own || memberFieldVisible(actor, target, 'members.contacts')) ? target.user.phone : null,
    bio: target.user.bio, avatarUrl: mediaUrl(target.user.avatarFileId), role: target.role,
    roleName: target.accessRole?.name ?? target.accessAssignments.find(item => item.locationId === actor.locationId)?.role.name ?? null,
    joinedAt: target.joinedAt, leftAt: target.leftAt, online: target.user.sessions.length > 0, lastSeenAt: target.user.lastSeenAt,
    positions: target.positions.map(item => item.position), locations: permittedPoints.map(item => item.location),
  }
  const [year, month] = options.month.split('-').map(Number)
  const from = `${options.month}-01`, to = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`
  const range = { gte: startOfZonedDate(from, actor.organization.timezone), lt: startOfZonedDate(to, actor.organization.timezone) }
  const base = { member, own, capabilities, location: { id: actor.locationId, name: actor.location.name, timezone: actor.organization.timezone }, month: options.month }
  if (options.section === 'time') {
    if (!capabilities.time) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Рабочее время недоступно.')
    return { ...base, time: await memberStatistics(userId, organizationId, memberId, { from, to, memberState: 'all', sort: 'name', direction: 'asc', page: options.page, limit: 15 }) }
  }
  if (options.section === 'documents') {
    if (!capabilities.documents || options.kind === 'personal' && !capabilities.personalDocuments || options.kind === 'acknowledgements' && !capabilities.acknowledgements) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Документы недоступны.')
    return { ...base, documents: await listMemberProfileDocuments(userId, organizationId, memberId, options.kind, options.page) }
  }
  if (options.section === 'requests') {
    if (!capabilities.requests) throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Заявки недоступны.')
    return { ...base, requests: await listRequests(userId, organizationId, 'profile', { page: options.page, pageSize: 15, memberId, ...(options.requestState === 'pending' ? { status: 'PENDING' as const } : {}) }) }
  }
  const now = new Date(), todayParts = zonedParts(new Date(), actor.organization.timezone)
  const today = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day))
  const [time, corrections, upcoming, nextAbsence, documents, requests] = await Promise.all([
    capabilities.time ? memberStatistics(userId, organizationId, memberId, { from, to, memberState: 'all', sort: 'name', direction: 'asc', page: 1, limit: 1 }) : null,
    capabilities.time ? prisma.workShift.count({ where: { organizationId, locationId: actor.locationId, memberId, scheduledStartAt: range, adjustments: { some: {} } } }) : null,
    capabilities.schedule ? prisma.workShift.findMany({ where: { organizationId, locationId: actor.locationId, memberId, status: 'SCHEDULED', scheduledEndAt: { gt: now } }, orderBy: { scheduledStartAt: 'asc' }, take: 2, select: { id: true, scheduledStartAt: true, scheduledEndAt: true, positionNameSnapshot: true } }) : null,
    capabilities.absences && (own || targetInPoint) ? prisma.employeeAbsence.findFirst({ where: { organizationId, memberId, cancelledAt: null, endDate: { gte: today } }, orderBy: { startDate: 'asc' }, select: { startDate: true, endDate: true, type: true } }) : null,
    capabilities.acknowledgements ? listMemberProfileDocuments(userId, organizationId, memberId, 'acknowledgements', 1, true) : null,
    capabilities.requests ? listRequests(userId, organizationId, 'profile', { page: 1, pageSize: 1, memberId, status: 'PENDING' }) : null,
  ])
  return { ...base, overview: { period: time?.period ?? null, corrections, upcoming, nextAbsence: nextAbsence ? { ...nextAbsence, type: own || hasPermission(actor, 'absences.details') ? nextAbsence.type : 'ABSENCE' } : null, pendingDocuments: documents?.pagination.total ?? null, pendingRequests: requests?.pagination.total ?? null } }
}
