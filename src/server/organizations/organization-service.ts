import { createHash } from 'node:crypto'
import { stableJson } from '../../shared/stable-json.ts'
import type { LocationProfile } from '../../shared/organization-profile.ts'
import { organizationAvailable } from './service-state.ts'
import { recordSecurityEvent } from '../security/journal.ts'
import { requireCapacity, subscriptionSnapshot } from '../subscriptions/access.ts'
import { effectiveSubscription } from '../../app/subscriptions/plans.ts'
import { hasPermission, requirePermission, ensureAccessRoles, locationsFor } from './access/access.ts'
import { revokeMemberAccess } from './access/member-lifecycle.ts'
import { locationMemberWhere, scopedLocationId } from './location-context.ts'
import { listNotificationHistory } from './notification-service.ts'
import { onlineSessions } from '../profile/presence.ts'
import { Prisma, type OrganizationRole } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { assertCanChangeRole, assertCanRemoveMember, getMembership } from './access/permissions.ts'
import { bindOrganizationLogoDraft, bindProfileImage, mediaUrl } from '../storage/image-service.ts'
import { seedSystemRequestTypes } from '../requests/service.ts'

type NewLocation = {name:string;city:string;address:string;timezone:string;teamNames?:string[]} & LocationProfile
export type CreateOrganizationInput = {initialPlan?:'FREE'|'TRIAL';name:string;description:string|null;timezone:string;industry?:string|null;contactEmail?:string|null;phone?:string|null;website?:string|null;address?:string|null;logoUploadId?:string|null;creationKey?:string;firstLocation?:NewLocation;locations?:NewLocation[]}
export type UpdateOrganizationInput = Pick<CreateOrganizationInput,'name'|'description'|'timezone'|'industry'> & {contactEmail:string|null;phone:string|null;website:string|null;address:string|null;logoUploadId?:string|null;profileRevision?:number}
function fingerprint(value:unknown):string {return createHash('sha256').update(stableJson(value)).digest('hex')}

export function locationMetadata(item:NewLocation,timezone:string){
 return {name:item.name,city:item.kind==='REMOTE'?'':item.city,address:item.kind==='REMOTE'?'':item.address,timezone:item.inheritsTimezone?timezone:item.timezone,kind:item.kind??'PHYSICAL',phone:item.phone??null,description:item.description??null,inheritsTimezone:item.inheritsTimezone??false,openingHours:item.openingHours==null?Prisma.DbNull:item.openingHours}
}
export async function createOrganization(userId:string,input:CreateOrganizationInput){
 if(input.initialPlan==='TRIAL')throw new ApiError(403,'SUBSCRIPTION_MANUAL_ONLY','Новые организации начинают с Бесплатного тарифа. После создания владелец может выбрать другой тариф в настройках без оплаты.')
 return prisma.$transaction(async tx=>{
  if(input.creationKey){
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId},519721))::text`
   const previous=await tx.organization.findUnique({where:{createdByUserId_creationKey:{createdByUserId:userId,creationKey:input.creationKey}},include:{locations:{orderBy:[{createdAt:'asc'},{id:'asc'}]}}})
   if(previous){
    if(previous.creationFingerprint!==fingerprint(input))throw new ApiError(409,'CREATION_CHANGED','Данные уже отправленного создания изменились. Проверьте список организаций перед новым созданием.')
    const member=await getMembership(userId,previous.id,tx)
    if(!member.owner)throw new ApiError(403,'OWNER_REQUIRED','Организация уже создана. Проверьте текущие права в списке организаций.')
    return {...previous,logoUrl:mediaUrl(previous.logoFileId),role:'OWNER' as const,organizationRole:'OWNER' as const,locations:previous.locations.map(point=>({...point,role:'OWNER' as const})),locationId:previous.locations[0].id,memberCount:await tx.organizationMember.count({where:{organizationId:previous.id,leftAt:null}})}
   }
  }
  const organization=await tx.organization.create({data:{name:input.name,description:input.description,industry:input.industry??null,timezone:input.timezone,contactEmail:input.contactEmail??null,phone:input.phone??null,website:input.website??null,address:input.address??null,createdByUserId:userId,creationKey:input.creationKey,creationFingerprint:input.creationKey?fingerprint(input):null}})
  await ensureAccessRoles(tx,organization.id)
  const owner=await tx.organizationMember.create({data:{organizationId:organization.id,userId,role:'OWNER'}})
  const locationInputs=[input.firstLocation??{name:'Основная точка',city:'',address:'',timezone:input.timezone},...(input.locations??[])],locations=[]
  await requireCapacity(tx,organization.id,'locations',locationInputs.length)
  for(const item of locationInputs){
   const location=await tx.organizationLocation.create({data:{...locationMetadata(item,input.timezone),organizationId:organization.id}})
   await tx.locationMember.create({data:{organizationId:organization.id,locationId:location.id,memberId:owner.id}})
   if(item.teamNames?.length)await tx.locationTeam.createMany({data:[...new Set(item.teamNames.filter(Boolean))].map(name=>({organizationId:organization.id,locationId:location.id,name}))})
   locations.push({...location,role:'OWNER' as const})
  }
  const logoFileId=input.logoUploadId?await bindOrganizationLogoDraft(tx,userId,organization.id,input.logoUploadId):null
  if(logoFileId)await tx.organization.update({where:{id:organization.id},data:{logoFileId}})
  await seedSystemRequestTypes(tx,organization.id)
  await tx.documentFolder.createMany({data:[{organizationId:organization.id,name:'Главная'},{organizationId:organization.id,name:'Документы сотрудников',systemKey:'employees:shared'}]})
  return {...organization,logoFileId,logoUrl:mediaUrl(logoFileId),role:'OWNER' as const,organizationRole:'OWNER' as const,locations,locationId:locations[0].id,memberCount:1}
 })
}

export async function listOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, leftAt: null, organization: { deletedAt: null } },
    include: { organization: { include: { subscription: true, _count: { select: { members: { where: { leftAt: null, user: { deletedAt: null } } } } } } } },
    orderBy: { joinedAt: 'asc' },
  })
  return memberships.map(({ organization, role, joinedAt }) => ({
    // The organization insert trigger and backfill guarantee this record.
    subscription: effectiveSubscription(organization.subscription!),
    service:{state:organizationAvailable(organization)?'ACTIVE' as const:'SUSPENDED' as const,until:organization.serviceUntil?.toISOString()??null},
    id: organization.id,
    publicId:organization.publicId,
    createdByViewer: organization.createdByUserId === userId,
    name: organization.name,
    description: organization.description,
    industry:organization.industry, profileRevision:organization.profileRevision,
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
    subscription: await subscriptionSnapshot(organizationId),
    id: membership.organization.id,
    publicId:membership.organization.publicId,
    name: membership.organization.name,
    description: membership.organization.description,
    industry:membership.organization.industry, profileRevision:membership.organization.profileRevision,
    timezone: membership.organization.timezone,
    role: membership.role,
    owner: membership.owner, permissions: membership.permissions, organizationPermissions: membership.organizationPermissions, permissionLocations: membership.permissionLocations, roleName: membership.roleName,
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
  requirePermission(membership, 'organization.edit', null)
  const { logoUploadId, profileRevision, ...fields } = input
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    requirePermission(await getMembership(userId, organizationId, tx), 'organization.edit', null)
    await tx.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId}::uuid FOR UPDATE`
    const current = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { logoFileId: true, profileRevision:true } })
    if(profileRevision!==undefined&&profileRevision!==current.profileRevision)throw new ApiError(409,'PROFILE_CHANGED','Профиль уже изменился. Обновите сведения перед сохранением.')
    const logoFileId = logoUploadId === undefined ? current.logoFileId : await bindProfileImage(tx, userId, current.logoFileId, logoUploadId, organizationId)
    await tx.organizationLocation.updateMany({where:{organizationId,inheritsTimezone:true,timezone:{not:input.timezone}},data:{timezone:input.timezone,revision:{increment:1}}})
    return tx.organization.update({ where: { id: organizationId }, data: { ...fields, logoFileId,profileRevision:{increment:1} } })
  })
}

export function memberFieldVisible(viewer: Awaited<ReturnType<typeof getMembership>>, member: { role: string; accessConfigured: boolean; accessRoleId: string | null; accessAssignments: Array<{locationId:string}>; locationMemberships:Array<{locationId:string}> }, key: 'members.contacts') {
  if (viewer.owner) return true
  if (!scopedLocationId(viewer.organizationId) && !viewer.accessConfigured) return hasPermission(viewer,key)
  if (member.role === 'OWNER' || member.accessRoleId) return locationsFor(viewer,key).length > 0
  return member.locationMemberships.some(l=>hasPermission(viewer,key,l.locationId)) || member.accessConfigured && member.accessAssignments.some(a=>hasPermission(viewer,key,a.locationId))
}

export async function listMembers(userId: string, organizationId: string) {
  const viewer = await getMembership(userId, organizationId)
  requirePermission(viewer, 'members.view')
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, ...locationMemberWhere(organizationId), leftAt: null, organization: { deletedAt: null }, user: { deletedAt: null } },
    include: { accessRole: true, accessAssignments: { include: { role: true } }, locationMemberships: { where: { leftAt: null }, select: { locationId: true, role: true } }, teamMemberships: { include: { team: { select: { id: true, name: true, locationId: true } } } }, positions: { where: { position: { isActive: true } }, include: { position: { select: { id: true, name: true } } } }, user: { select: { id: true, email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, lastSeenAt: true, avatarFileId: true, sessions: { where: onlineSessions(), select: { id: true }, take: 1 } } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  })
  return members.map((member) => {
    const displayName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || (memberFieldVisible(viewer,member,'members.contacts') ? member.user.email.split('@')[0] : 'Участник организации')
    return { positions: member.positions.map(item => item.position), id: member.id, accessRoleName: member.accessRole?.name ?? null, accessAssignments: (member.accessConfigured ? member.accessAssignments : []).map(a => ({ locationId: a.locationId, roleId: a.roleId, roleName: a.role.name })), userId: member.userId, email: memberFieldVisible(viewer, member, 'members.contacts') ? member.user.email : '', displayName, firstName: member.user.firstName, lastName: member.user.lastName, middleName: member.user.middleName, phone: memberFieldVisible(viewer, member, 'members.contacts') ? member.user.phone : null, bio: member.user.bio, avatarUrl: mediaUrl(member.user.avatarFileId), lastSeenAt: member.user.lastSeenAt, online: member.user.sessions.length > 0, role: member.role === 'OWNER' ? 'OWNER' : scopedLocationId(organizationId) ? member.locationMemberships.find(m => m.locationId === scopedLocationId(organizationId))?.role ?? 'MEMBER' : member.role, locations: member.locationMemberships, teams: member.teamMemberships.map(m => m.team), joinedAt: member.joinedAt }
  })
}

export async function listMembersPage(userId: string, organizationId: string, options: { directory?: string; pointId?: string; page?: number; pageSize?: number; role?: OrganizationRole; accessRoleId?:string; search?: string; positionId?: string }) {
  const viewer = await getMembership(userId, organizationId)
  requirePermission(viewer, 'members.view')
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? 20
  const readable = locationsFor(viewer,'members.view')
  if(options.pointId && !viewer.owner && !readable.includes(options.pointId)) requirePermission(viewer,'members.view',options.pointId)
  const accessRole=options.accessRoleId ? (await ensureAccessRoles(prisma,organizationId)).find(r=>r.id===options.accessRoleId) : undefined
  const terms = options.search?.trim().split(/\s+/).filter(Boolean) ?? []
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId,
    ...(options.directory === 'true' ? viewer.owner && !options.pointId ? {} : {OR:[{locationMemberships:{some:{leftAt:null,location:{archivedAt:null},locationId:options.pointId ?? {in:readable}}}},{accessAssignments:{some:{locationId:options.pointId ?? {in:readable}}}},{accessRoleId:{not:null}}]} : locationMemberWhere(organizationId)),
    ...(options.accessRoleId ? {AND:[{OR:[{accessRoleId:options.accessRoleId},{accessAssignments:{some:{roleId:options.accessRoleId}}},...(accessRole?.systemCode==='OWNER' ? [{role:'OWNER' as const}] : accessRole?.systemCode ? [{accessConfigured:false,locationMemberships:{some:{leftAt:null,role:accessRole.systemCode as 'ADMIN'|'MEMBER'}}}] : [])]}]} : {}),
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
      include: { accessRole: true, accessAssignments: { include: { role: true } }, locationMemberships: { where: { leftAt: null }, select: { locationId: true, role: true } }, teamMemberships: { include: { team: { select: { id: true, name: true, locationId: true } } } }, positions: { where: { position: { isActive: true } }, include: { position: { select: { id: true, name: true } } } }, user: { select: { id: true, email: true, firstName: true, lastName: true, middleName: true, phone: true, bio: true, lastSeenAt: true, avatarFileId: true, sessions: { where: onlineSessions(), select: { id: true }, take: 1 } } } },
      orderBy: [{ role: 'asc' }, { user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { user: { email: 'asc' } }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    members: members.map((member) => {
      const displayName = [member.user.lastName, member.user.firstName, member.user.middleName].filter(Boolean).join(' ') || (memberFieldVisible(viewer,member,'members.contacts') ? member.user.email.split('@')[0] : 'Участник организации')
      return { positions: member.positions.map(item => item.position), id: member.id, accessRoleName: member.accessRole?.name ?? null, accessAssignments: (member.accessConfigured ? member.accessAssignments : []).map(a => ({ locationId: a.locationId, roleId: a.roleId, roleName: a.role.name })), userId: member.userId, email: memberFieldVisible(viewer, member, 'members.contacts') ? member.user.email : '', displayName, firstName: member.user.firstName, lastName: member.user.lastName, middleName: member.user.middleName, phone: memberFieldVisible(viewer, member, 'members.contacts') ? member.user.phone : null, bio: member.user.bio, avatarUrl: mediaUrl(member.user.avatarFileId), lastSeenAt: member.user.lastSeenAt, online: member.user.sessions.length > 0, role: member.role, locations: member.locationMemberships, teams: member.teamMemberships.map(m => m.team), joinedAt: member.joinedAt }
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
    const roles = await ensureAccessRoles(tx,organizationId), assignedRole = roles.find(r=>r.systemCode===nextRole)!
    await tx.accessAssignment.updateMany({where:{organizationId,memberId:target.id},data:{roleId:assignedRole.id}})
    const updated = await tx.organizationMember.update({ where: { id: target.id }, data: { role: nextRole,accessRoleId:null,accessConfigured:false } })
    if (nextRole === 'MEMBER') await tx.documentAcknowledgement.updateMany({ where: { memberId: target.id, acknowledgedAt: null, cancelledAt: null, document: { organizationId, OR: [{ visibility: 'ADMINS' }, { visibility: 'PRIVATE_MEMBER', targetMemberId: { not: target.id } }] } }, data: { cancelledAt: new Date() } })
    await tx.accountNotification.create({ data: { userId: target.userId, organizationId, type: 'ROLE_CHANGED', title: 'Роль изменена', message: `В организации «${actor.organization.name}» вам назначена роль «${roleName}».` } })
    await recordSecurityEvent(tx, { action: 'ACCESS_CHANGED', userId: actorUserId, organizationId, resourceType: 'MEMBER', resourceId: target.id })
    return updated
  })
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
  if (target.role==='OWNER') throw new ApiError(403,'INSUFFICIENT_PERMISSIONS','Владельца нельзя исключить.')
  if (!actor.accessConfigured && !scopedLocationId(organizationId) && actor.organizationRole==='ADMIN') assertCanRemoveMember(actor.role,target.role)
  else requirePermission(actor,'members.exclude',null)
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    await tx.documentAcknowledgement.updateMany({ where: { memberId: target.id, acknowledgedAt: null, cancelledAt: null, document: { organizationId } }, data: { cancelledAt: now } })
    await tx.workShift.updateMany({ where: { organizationId, memberId: target.id, status: 'SCHEDULED', scheduledStartAt: { gt: now } }, data: { status: 'CANCELLED', cancelledAt: now, cancelledByMemberId: actor.id, cancellationReason: 'Сотрудник покинул организацию' } })
    await revokeMemberAccess(tx, organizationId, target.id, now)
    await tx.organizationMember.update({ where: { id: target.id }, data: { leftAt: now } })
    await recordSecurityEvent(tx, { action: 'MEMBER_DEPARTED', userId: actorUserId, organizationId, resourceType: 'MEMBER', resourceId: target.id })
    const pending = await tx.organizationRequest.findMany({ where: { organizationId, createdByMemberId: target.id, status: 'PENDING' }, select: { id: true } })
    if (pending.length) {
      const ids = pending.map((request) => request.id)
      await tx.organizationRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', cancelledAt: now, resolutionComment: 'Участник покинул организацию' } })
      await tx.requestEvent.createMany({ data: ids.map((requestId) => ({ requestId, actorMemberId: actor.id, type: 'CANCELLED' as const, comment: 'Участник покинул организацию' })) })
      await tx.accountNotification.updateMany({ where: { requestId: { in: ids }, readAt: null }, data: { readAt: now } })
    }
  }, { isolationLevel: 'Serializable' })
}
