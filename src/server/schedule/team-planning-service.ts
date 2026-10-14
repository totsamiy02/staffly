import { randomUUID } from 'node:crypto'
import type { Prisma, ScheduleDraft, DraftShift } from '../../generated/prisma/client.ts'
import type { WorkShift as PublicShift } from '../../app/schedule/types.ts'
import type { DemandWeek, DraftProposal, DraftValidation } from '../../app/schedule/team-planning-types.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { hasPermission, requirePermission } from '../organizations/access.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { sendImportantShiftEmail } from '../organizations/notification-service.ts'
import { activeTarget, assertNoApprovedAbsence, mutatePlannedShift, publicShift, shiftInclude, shiftConflictMessage, validateDuration, type ShiftInput } from './service.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../app/schedule/date-utils.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from './timezone.ts'
import { checkMonthlyWorkload } from './workload.ts'
import { calculateCoverage, validateDemandSchedule } from './coverage.ts'
import * as schemas from './team-planning-schemas.ts'
import type { z } from 'zod'

type DB = Prisma.TransactionClient
type Actor = Awaited<ReturnType<typeof getMembership>>
const dateText = (value: Date) => value.toISOString().slice(0, 10)
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value))
const name = (user: { firstName: string | null; lastName: string | null; middleName: string | null }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || 'Сотрудник'
const memberInclude = { user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true, deletedAt: true } } } as const
const activeStatuses = ['PREPARING','OPEN','CLOSED'] as const
function localToday(timezone: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
async function organizationLock(tx: DB, organizationId: string) { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text` }
async function demandData(tx: DB, organizationId: string, locationId: string) {
  const [versions, exceptions] = await Promise.all([
    tx.demandVersion.findMany({ where: { organizationId, locationId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
    tx.demandException.findMany({ where: { organizationId, locationId }, orderBy: { date: 'asc' } }),
  ])
  return { versions: versions.map(v => ({ id: v.id, effectiveFrom: dateText(v.effectiveFrom), days: v.days as DemandWeek })), exceptions: exceptions.map(e => ({ date: dateText(e.date), intervals: e.intervals as NonNullable<DemandWeek[number]> })) }
}
export async function getTeamSettings(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  return { coverageEnabled: actor.location.coverageEnabled, discussionEnabled: actor.location.discussionEnabled, discussionHours: actor.location.discussionHours }
}
export async function saveTeamSettings(userId: string, organizationId: string, input: z.infer<typeof schemas.teamSettingsBody>) {
  return prisma.$transaction(async tx => {
    await organizationLock(tx, organizationId)
    const actor = await getMembership(userId, organizationId, tx); requirePermission(actor, 'schedule.settings')
    if (!input.discussionEnabled && await tx.scheduleDraft.count({ where: { organizationId, locationId: actor.locationId, status: { in: [...activeStatuses] } } })) throw new ApiError(409, 'ACTIVE_DISCUSSION', 'Сначала примените или явно отмените незавершённые предварительные графики. История сохранится.')
    return tx.organizationLocation.update({ where: { id: actor.locationId }, data: input, select: { coverageEnabled: true, discussionEnabled: true, discussionHours: true } })
  })
}
export async function getDemand(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'coverage.view')
  return demandData(prisma, organizationId, actor.locationId)
}
export async function saveDemand(userId: string, organizationId: string, input: z.infer<typeof schemas.demandVersionBody> | z.infer<typeof schemas.demandExceptionBody>) {
  return prisma.$transaction(async tx => {
    await organizationLock(tx, organizationId)
    const actor = await getMembership(userId, organizationId, tx); requirePermission(actor, 'coverage.manage')
    if (!actor.location.coverageEnabled) throw new ApiError(409, 'COVERAGE_DISABLED', 'Включите потребность и покрытие в настройках расписания.')
    const data = await demandData(tx, organizationId, actor.locationId)
    const intervals = 'days' in input ? input.days.flatMap(day => day ?? []) : input.intervals ?? []
    const ids = [...new Set(intervals.map(i => i.positionId))]
    if (await tx.organizationPosition.count({ where: { id: { in: ids }, organizationId, isActive: true } }) !== ids.length) throw new ApiError(400, 'POSITION_INACTIVE', 'Выберите действующие должности организации.')
    if ('days' in input) {
      if (input.effectiveFrom < localToday(actor.organization.timezone)) throw new ApiError(400, 'DEMAND_PAST', 'Новая редакция шаблона действует с сегодняшней или будущей даты.')
      const versions = [...data.versions, input].sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      validateDemandSchedule(versions, data.exceptions)
      // Append even when the effective date is the same: earlier revisions remain in history.
      const latest = await tx.demandVersion.findFirst({ where: { organizationId, locationId: actor.locationId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      const createdAt = new Date(Math.max(Date.now(), latest ? +latest.createdAt + 1 : 0))
      return tx.demandVersion.create({ data: { organizationId, locationId: actor.locationId, effectiveFrom: new Date(input.effectiveFrom), days: json(input.days), createdAt } })
    }
    if (input.date < localToday(actor.organization.timezone)) throw new ApiError(400, 'DEMAND_PAST', 'Изменяйте потребность на сегодняшнюю или будущую дату.')
    const exceptions = data.exceptions.filter(e => e.date !== input.date)
    if (input.intervals !== null) exceptions.push({ date: input.date, intervals: input.intervals })
    validateDemandSchedule(data.versions, exceptions)
    if (input.intervals === null) return tx.demandException.deleteMany({ where: { locationId: actor.locationId, date: new Date(input.date) } })
    return tx.demandException.upsert({ where: { locationId_date: { locationId: actor.locationId, date: new Date(input.date) } }, create: { organizationId, locationId: actor.locationId, date: new Date(input.date), intervals: json(input.intervals) }, update: { intervals: json(input.intervals) } })
  })
}
async function coverageFor(tx: DB, actor: Actor, from: string, to: string, shifts?: PublicShift[]) {
  if (!actor.location.coverageEnabled || !hasPermission(actor, 'coverage.view')) return []
  const data = await demandData(tx, actor.organizationId, actor.locationId)
  const positions = await tx.organizationPosition.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, name: true } })
  const assigned = shifts ?? await tx.workShift.findMany({ where: { organizationId: actor.organizationId, locationId: actor.locationId, status: 'SCHEDULED', scheduledStartAt: { lt: startOfZonedDate(to, actor.organization.timezone) }, scheduledEndAt: { gt: startOfZonedDate(from, actor.organization.timezone) } } })
  return calculateCoverage(from, to, actor.organization.timezone, data.versions, data.exceptions, assigned, positions)
}
export async function getCoverage(userId: string, organizationId: string, from: string, to: string) {
  const actor = await getMembership(userId, organizationId); requirePermission(actor, 'coverage.view')
  return { days: await coverageFor(prisma, actor, from, to) }
}
export async function saveDemandDates(userId: string, organizationId: string, input: z.infer<typeof schemas.demandDatesBody>) {
  return prisma.$transaction(async tx => {
    await organizationLock(tx, organizationId)
    const actor = await getMembership(userId, organizationId, tx); requirePermission(actor, 'coverage.manage')
    if (!actor.location.coverageEnabled) throw new ApiError(409, 'COVERAGE_DISABLED', 'Включите потребность в настройках расписания.')
    if (input.dates.some(day => day.date < localToday(actor.organization.timezone))) throw new ApiError(400, 'DEMAND_PAST', 'Выберите сегодняшние или будущие даты.')
    if (input.repeat && input.repeat.effectiveFrom < localToday(actor.organization.timezone)) throw new ApiError(400, 'DEMAND_PAST', 'Повторение начинается с сегодняшней или будущей даты.')
    const ids = [...new Set([...input.dates.flatMap(day => day.intervals ?? []), ...(input.repeat?.days.flatMap(day => day ?? []) ?? [])].map(row => row.positionId))]
    if (await tx.organizationPosition.count({ where: { id: { in: ids }, organizationId, isActive: true } }) !== ids.length) throw new ApiError(400, 'POSITION_INACTIVE', 'Выберите действующие должности организации.')
    const data = await demandData(tx, organizationId, actor.locationId)
    const selected = new Set(input.dates.map(day => day.date))
    const exceptions = [...data.exceptions.filter(day => !selected.has(day.date)), ...input.dates.filter(day => day.intervals !== null).map(day => ({ date: day.date, intervals: day.intervals! }))]
    const versions = input.repeat ? [...data.versions, input.repeat].sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom)) : data.versions
    validateDemandSchedule(versions, exceptions)
    if (input.repeat) {
      const latest = await tx.demandVersion.findFirst({ where: { organizationId, locationId: actor.locationId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      await tx.demandVersion.create({ data: { organizationId, locationId: actor.locationId, effectiveFrom: new Date(input.repeat.effectiveFrom), days: json(input.repeat.days), createdAt: new Date(Math.max(Date.now(), latest ? +latest.createdAt + 1 : 0)) } })
    }
    for (const day of input.dates) {
      if (day.intervals === null) await tx.demandException.deleteMany({ where: { locationId: actor.locationId, date: new Date(day.date) } })
      else await tx.demandException.upsert({ where: { locationId_date: { locationId: actor.locationId, date: new Date(day.date) } }, create: { organizationId, locationId: actor.locationId, date: new Date(day.date), intervals: json(day.intervals) }, update: { intervals: json(day.intervals) } })
    }
    return { savedDates: input.dates.map(day => day.date) }
  })
}
function publicDraft(d: ScheduleDraft) {
  // The full frozen calendar is private; only getDraft returns its authorized slice.
  return { id:d.id, organizationId:d.organizationId, locationId:d.locationId, authorMemberId:d.authorMemberId, title:d.title, description:d.description, fromDate:dateText(d.fromDate), toDate:dateText(d.toDate), timezone:d.timezone, status:d.status, revision:d.revision, deadline:d.deadline, publishedAt:d.publishedAt, finishedAt:d.finishedAt, finishedByMemberId:d.finishedByMemberId, createdAt:d.createdAt, updatedAt:d.updatedAt }
}
function proposal(p: DraftShift): DraftProposal { return { ...p, source: p.source as DraftProposal['source'], proposed: p.proposed as PublicShift, kind: p.kind as DraftProposal['kind'] } }
async function history(tx: DB, d: ScheduleDraft, actor: Actor, action: string, details: unknown = {}) {
  await tx.draftHistory.create({ data: { organizationId: d.organizationId, draftId: d.id, actorMemberId: actor.id, revision: d.revision, action, details: json(details) } })
}
async function expire(tx: DB, organizationId: string) {
  await tx.scheduleDraft.updateMany({ where: { organizationId, status: 'OPEN', deadline: { lte: new Date() } }, data: { status: 'CLOSED' } })
}
async function draftFor(tx: DB, actor: Actor, id: string, revision?: number) {
  const d = await tx.scheduleDraft.findFirst({ where: { id, organizationId: actor.organizationId, locationId: actor.locationId } })
  if (!d) throw new ApiError(404, 'DRAFT_NOT_FOUND', 'Предварительный график не найден в этой точке.')
  if (revision !== undefined && d.revision !== revision) throw new ApiError(409, 'DRAFT_CHANGED', 'График изменился. Обновите страницу и повторите действие.')
  return d
}
async function accessible(tx: DB, actor: Actor, d: ScheduleDraft) {
  const manager = hasPermission(actor, 'drafts.view')
  const recipient = d.publishedAt && await tx.draftRecipient.findUnique({ where: { draftId_memberId: { draftId: d.id, memberId: actor.id } } })
  if (!manager && !recipient) throw new ApiError(404, 'DRAFT_NOT_FOUND', 'Обсуждение недоступно.')
  return { manager, recipient }
}
function editable(d: ScheduleDraft) { if (!activeStatuses.some(s => s === d.status)) throw new ApiError(409, 'DRAFT_CLOSED', 'Этот график уже применён или отменён.') }
function open(d: ScheduleDraft) { if (d.status !== 'OPEN' || !d.deadline || d.deadline <= new Date()) throw new ApiError(409, 'DISCUSSION_CLOSED', 'Обсуждение закрыто. Руководитель может открыть его повторно.') }
async function workPicture(tx: DB, _actor: Actor, d: ScheduleDraft, proposals: DraftProposal[]) {
  if (d.appliedSnapshot) return d.appliedSnapshot as PublicShift[]
  const current = await tx.workShift.findMany({ where: { organizationId: d.organizationId, locationId: d.locationId, status: 'SCHEDULED', scheduledStartAt: { lt: startOfZonedDate(addCalendarDays(dateText(d.toDate), 1), d.timezone) }, scheduledEndAt: { gt: startOfZonedDate(dateText(d.fromDate), d.timezone) } }, include: shiftInclude })
  const ids = new Set(proposals.filter(p => p.kind !== 'KEEP').map(p => p.sourceShiftId))
  return [...current.filter(s => !ids.has(s.id)).map(s => json(publicShift(s)) as unknown as PublicShift), ...proposals.filter(p => p.kind === 'CREATE' || p.kind === 'UPDATE').map(p => p.proposed)]
}
export async function listDrafts(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  await expire(prisma, organizationId)
  const drafts = await prisma.scheduleDraft.findMany({ where: { organizationId, locationId: actor.locationId, ...(!hasPermission(actor,'drafts.view') ? { publishedAt: { not: null }, recipients: { some: { memberId: actor.id } } } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 })
  return { drafts: drafts.map(publicDraft) }
}
export async function listDraftInbox(userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId)
  await expire(prisma, organizationId)
  const drafts = await prisma.scheduleDraft.findMany({ where: { organizationId, status: { in: [...activeStatuses] } }, include: { location: { select: { name: true } }, recipients: { where: { memberId: actor.id } } }, orderBy: { createdAt: 'desc' } })
  return { drafts: drafts.filter(d => hasPermission(actor, 'drafts.view', d.locationId) || !!d.publishedAt && d.recipients.length > 0).map(d => ({ ...publicDraft(d), locationName: d.location.name, canManage: hasPermission(actor, 'drafts.view', d.locationId), ownResponse: d.recipients[0]?.response ?? null, needsResponse: d.status === 'OPEN' && !!d.recipients[0] && (!d.recipients[0].response || d.recipients[0].respondedRevision !== d.recipients[0].requiredRevision) })) }
}
export async function createDraft(userId: string, organizationId: string, input: z.infer<typeof schemas.draftCreateBody>) {
  return prisma.$transaction(async tx => {
    await organizationLock(tx, organizationId)
    const actor = await getMembership(userId, organizationId, tx); requirePermission(actor,'drafts.edit')
    if (!actor.location.discussionEnabled) throw new ApiError(409, 'DISCUSSION_DISABLED', 'Включите предварительное согласование в настройках расписания.')
    if (actor.location.archivedAt) throw new ApiError(409, 'LOCATION_ARCHIVED', 'Точка закрыта.')
    const existing = await tx.scheduleDraft.findFirst({ where: { organizationId, locationId: actor.locationId, status: { in: [...activeStatuses] }, fromDate: { lte: new Date(input.toDate) }, toDate: { gte: new Date(input.fromDate) } } })
    if (existing) throw new ApiError(409, 'DRAFT_PERIOD_OVERLAP', 'В этом периоде уже есть незавершённый график: «' + existing.title + '».', { draftId: existing.id })
    const d = await tx.scheduleDraft.create({ data: { title: input.title, description: input.description, fromDate: new Date(input.fromDate), toDate: new Date(input.toDate), organizationId, locationId: actor.locationId, authorMemberId: actor.id, timezone: actor.organization.timezone } })
    if (input.importCurrent) {
      requirePermission(actor,'schedule.view')
      const shifts = await tx.workShift.findMany({ where: { organizationId, locationId: actor.locationId, status: 'SCHEDULED', scheduledStartAt: { gte: startOfZonedDate(input.fromDate, d.timezone), lt: startOfZonedDate(addCalendarDays(input.toDate,1), d.timezone) } }, include: shiftInclude })
      if (shifts.length) await tx.draftShift.createMany({ data: shifts.map(s => ({ draftId: d.id, sourceShiftId: s.id, source: json({ ...publicShift(s), updatedAt: s.updatedAt }), proposed: json(publicShift(s)), kind: 'KEEP', revision: 1 })) })
    }
    await history(tx,d,actor,'CREATED',{ importCurrent: input.importCurrent })
    return publicDraft(d)
  })
}
export async function getDraft(userId: string, organizationId: string, id: string) {
  const actor = await getMembership(userId, organizationId)
  await expire(prisma, organizationId)
  const d = await draftFor(prisma,actor,id), { manager } = await accessible(prisma,actor,d)
  const team = manager && hasPermission(actor,'schedule.view')
  const [rows, recipients, comments, events] = await Promise.all([
    prisma.draftShift.findMany({ where: { draftId: id }, orderBy: { id: 'asc' } }),
    prisma.draftRecipient.findMany({ where: { draftId: id, ...(!manager ? { memberId: actor.id } : {}) }, include: { member: { include: memberInclude } } }),
    prisma.draftComment.findMany({ where: { draftId: id, ...(!manager ? { memberId: actor.id } : {}) }, include: { member: { include: memberInclude } }, orderBy: { createdAt: 'asc' } }),
    prisma.draftHistory.findMany({ where: { draftId: id, ...(!manager ? { actorMemberId: actor.id } : {}) }, include: { actor: { include: memberInclude } }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ])
  const allProposals = rows.map(proposal), allShifts = await workPicture(prisma,actor,d,allProposals)
  const visible = (s: PublicShift) => team || s.memberId === actor.id
  const active = recipients.filter(r => !r.member.leftAt && !r.member.user.deletedAt)
  const visibleProposals: DraftProposal[] = allProposals.filter(p=>visible(p.proposed) || !!p.source && visible(p.source)).map(p=>team?p:({ ...p, source: p.source && visible(p.source)?p.source:null, ...(visible(p.proposed)?{}:{kind:'CANCEL',proposed:p.source!}) }))
  const changes = visibleProposals.filter(p=>p.kind!=='KEEP')
  return { ...publicDraft(d), appliedSnapshot: undefined, proposals: visibleProposals, shifts: allShifts.filter(visible), coverage: await coverageFor(prisma,actor,dateText(d.fromDate),addCalendarDays(dateText(d.toDate),1),allShifts), viewerMemberId: actor.id, canManage: manager,
    recipients: recipients.map(r=>({ memberId:r.memberId, memberName:name(r.member.user), memberAvatarUrl:mediaUrl(r.member.user.avatarFileId), active: !r.member.leftAt && !r.member.user.deletedAt, requiredRevision:r.requiredRevision, respondedRevision:r.respondedRevision, response:r.response, respondedAt:r.respondedAt })),
    comments:comments.map(c=>({ ...c, member:undefined, date:c.date ? dateText(c.date):null, memberName:name(c.member.user), memberAvatarUrl:mediaUrl(c.member.user.avatarFileId) })),
    history:events.map(e=>({ ...e, actor:undefined, actorName:name(e.actor.user), details: !manager && e.action==='PROPOSALS_CHANGED' ? {} : e.details })),
    counts:{ participants:active.length, noObjections:active.filter(r=>r.response==='NO_OBJECTIONS' && r.respondedRevision===r.requiredRevision).length, objections:active.filter(r=>r.response==='OBJECTIONS' && r.respondedRevision===r.requiredRevision).length, unanswered:active.filter(r=>!r.response || r.respondedRevision!==r.requiredRevision).length, openComments:comments.filter(c=>c.status==='OPEN').length, create:changes.filter(p=>p.kind==='CREATE' && (manager || visible(p.proposed))).length, update:changes.filter(p=>p.kind==='UPDATE' && (manager || visible(p.proposed))).length, cancel:changes.filter(p=>p.kind==='CANCEL' && (manager || visible(p.proposed))).length, affected: manager ? new Set(changes.flatMap(p=>[p.proposed.memberId,p.source?.memberId].filter(Boolean))).size : 1 }
  }
}
async function notification(tx: DB, d: ScheduleDraft, memberIds: string[], title: string, message: string) {
  const members = await tx.organizationMember.findMany({ where: { organizationId: d.organizationId, id: { in: [...new Set(memberIds)] }, leftAt: null, user: { deletedAt: null } }, select: { userId: true } })
  if (members.length) await tx.accountNotification.createMany({ data: members.map(m=>({ organizationId: d.organizationId, scheduleDraftId: d.id, userId: m.userId, type: 'SCHEDULE_DISCUSSION', title, message: message.slice(0,500) })) })
}
async function withDraft<T>(userId: string, organizationId: string, id: string, revision: number | undefined, fn: (tx:DB, actor:Actor, d:ScheduleDraft)=>Promise<T>) {
  return prisma.$transaction(async tx=> {
    await organizationLock(tx,organizationId)
    await tx.$queryRaw`SELECT id FROM schedule_drafts WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`
    const actor = await getMembership(userId,organizationId,tx)
    await expire(tx,organizationId)
    const d = await draftFor(tx,actor,id,revision)
    return fn(tx,actor,d)
  }, { isolationLevel:'Serializable', timeout:30000 }).catch(error => {
    if (error?.code === 'P2034') throw new ApiError(409,'DRAFT_CHANGED','График или рабочий календарь изменился. Обновите страницу и повторите действие.')
    throw error
  })
}
export async function editDraft(userId:string,organizationId:string,id:string,input:z.infer<typeof schemas.draftEditBody>) {
  return withDraft(userId,organizationId,id,input.revision,async(tx,actor,d)=> {
    requirePermission(actor,'drafts.edit');editable(d)
    const changed = await tx.scheduleDraft.update({ where:{id}, data:{title:input.title,description:input.description,revision:{increment:1}} })
    await history(tx,changed,actor,'DETAILS_CHANGED',{title:input.title,description:input.description})
    return publicDraft(changed)
  })
}
async function makeProposed(tx: DB, actor: Actor, input: ShiftInput, id: string): Promise<PublicShift> {
  const start = zonedDateTimeToUtc(input.startDate,input.startTime,actor.organization.timezone), end = zonedDateTimeToUtc(input.endDate,input.endTime,actor.organization.timezone)
  validateDuration(start,end,input.breakMinutes)
  const member = await activeTarget(tx,actor.organizationId,input.memberId,start,end)
  const user = await tx.user.findUniqueOrThrow({where:{id:member.userId},select:{firstName:true,lastName:true,middleName:true,avatarFileId:true}})
  const position = input.positionId ? await tx.organizationPosition.findFirst({ where:{id:input.positionId,organizationId:actor.organizationId,isActive:true,members:{some:{memberId:input.memberId}}} }):null
  if(input.positionId && !position) throw new ApiError(400,'POSITION_NOT_ASSIGNED','Должность не назначена сотруднику.')
  return { id, memberId:member.id, memberName:name(user),memberAvatarUrl:mediaUrl(user.avatarFileId), positionId:position?.id??null,positionName:position?.name??null,scheduledStartAt:start.toISOString(),scheduledEndAt:end.toISOString(),breakMinutes:input.breakMinutes,description:input.description,actualStartAt:null,actualEndAt:null,actualBreakMinutes:null,effectiveMinutes:(+end-+start)/60000-input.breakMinutes,status:'SCHEDULED',cancelledAt:null,cancellationReason:null,adjusted:false }
}
function material(s:PublicShift) { return JSON.stringify([s.memberId,s.scheduledStartAt,s.scheduledEndAt,s.positionId??null]) }
export async function changeDraftProposals(userId:string,organizationId:string,id:string,input:z.infer<typeof schemas.draftProposalBody>) {
  return withDraft(userId,organizationId,id,input.revision,async(tx,actor,d)=> {
    requirePermission(actor,'drafts.edit');editable(d)
    if(actor.organization.timezone!==d.timezone) throw new ApiError(409,'DRAFT_TIMEZONE_CHANGED','Часовой пояс точки изменился. Создайте график в актуальном часовом поясе.')
    const row = input.proposalId ? await tx.draftShift.findFirst({where:{id:input.proposalId,draftId:id}}):null
    if(input.proposalId && !row) throw new ApiError(404,'PROPOSAL_NOT_FOUND','Предложение не найдено.')
    if((input.kind==='REMOVE'||input.kind==='REFRESH')&&!row) throw new ApiError(400,'PROPOSAL_REQUIRED','Выберите предложение.')
    const affected = new Set<string>(), changes:unknown[]=[]
    const mark=(s:PublicShift|null)=>{if(s)affected.add(s.memberId)}
    const old = row ? proposal(row):null
    if(input.kind==='REMOVE') {
      mark(old!.proposed);mark(old!.source)
      await tx.draftShift.delete({where:{id:row!.id}});changes.push({removed:old})
    } else if(input.kind==='REFRESH') {
      if(!row!.sourceShiftId) throw new ApiError(400,'SOURCE_REQUIRED','У новой смены нет исходной записи.')
      const source = await tx.workShift.findFirst({where:{id:row!.sourceShiftId,organizationId,locationId:d.locationId},include:shiftInclude})
      if(!source || source.status!=='SCHEDULED') throw new ApiError(409,'SOURCE_GONE','Исходная смена отменена или недоступна. Уберите предложение и создайте новое.')
      mark(old!.source);mark(old!.proposed);mark(json(publicShift(source)) as unknown as PublicShift)
      await tx.draftShift.update({where:{id:row!.id},data:{source:json({...publicShift(source),updatedAt:source.updatedAt}),revision:d.revision+1}})
      changes.push({refreshed:row!.id,source:publicShift(source)})
    } else {
      if(input.kind!=='CANCEL' && (input.shifts.length<1 || (input.kind==='UPDATE' && input.shifts.length!==1))) throw new ApiError(400,'SHIFT_REQUIRED','Укажите предлагаемые смены.')
      const sourceId=row?.sourceShiftId??input.sourceShiftId
      if(input.kind==='CREATE' && (row?.sourceShiftId || input.sourceShiftId)) throw new ApiError(400,'SOURCE_UNEXPECTED','Для исходной смены выберите изменение или отмену.')
      const source=sourceId ? await tx.workShift.findFirst({where:{id:sourceId,organizationId,locationId:d.locationId,status:'SCHEDULED'},include:shiftInclude}):null
      if(input.kind!=='CREATE'&&!source) throw new ApiError(404,'SOURCE_NOT_FOUND','Исходная смена не найдена.')
      if(sourceId && !row && await tx.draftShift.count({where:{draftId:id,sourceShiftId:sourceId}})) throw new ApiError(409,'SOURCE_ALREADY_PROPOSED','Для этой смены уже есть предложение. Откройте его для изменения.')
      const snapshots = input.kind==='CANCEL' ? [json(publicShift(source!)) as unknown as PublicShift] : await Promise.all(input.shifts.map((s,index)=>makeProposed(tx,actor,s,index===0&&row?row.id:randomUUID())))
      for(let index=0;index<snapshots.length;index++) {
        const s=snapshots[index]
        const start=s.scheduledStartAt
        if(start < startOfZonedDate(dateText(d.fromDate),d.timezone).toISOString() || start>=startOfZonedDate(addCalendarDays(dateText(d.toDate),1),d.timezone).toISOString()) throw new ApiError(400,'OUTSIDE_DRAFT_PERIOD','Начало предлагаемой смены должно входить в период графика.')
        const record={proposed:json(s),kind:input.kind,revision:d.revision+1,...(source ? {source:old?.source ? json(old.source):json({...publicShift(source),updatedAt:source.updatedAt}),sourceShiftId:source.id}:{})}
        if(row && index===0) await tx.draftShift.update({where:{id:row.id},data:record})
        else await tx.draftShift.create({data:{...record,id:input.kind==='CANCEL'?randomUUID():s.id,draftId:id}})
        if(!old||input.kind==='CANCEL'||material(old.proposed)!==material(s)) {mark(s);mark(old?.proposed??null);mark(old?.source??(source?json(publicShift(source)) as unknown as PublicShift:null))}
        changes.push({before:old,after:record})
      }
    }
    if(d.publishedAt && affected.size && d.status==='CLOSED' && !input.deadline) throw new ApiError(400,'REOPEN_REQUIRED','Обсуждение завершено. При правке смен задайте новый будущий срок для повторного ознакомления.')
    if(d.publishedAt && affected.size && !input.confirmResponseWindow) throw new ApiError(400,'RESPONSE_WINDOW_REQUIRED','Подтвердите, что времени для повторного ознакомления достаточно, либо продлите обсуждение.')
    let deadline=d.deadline, status=d.status
    if(input.deadline) {deadline=new Date(input.deadline);if(deadline<=new Date())throw new ApiError(400,'DEADLINE_PAST','Новый срок должен быть в будущем.');if(d.publishedAt)status='OPEN'}
    const changed = await tx.scheduleDraft.update({where:{id},data:{revision:{increment:1},deadline,status}})
    if(d.publishedAt && affected.size) {
      await tx.draftRecipient.updateMany({where:{draftId:id,memberId:{in:[...affected]}},data:{requiredRevision:changed.revision}})
      const existing=await tx.draftRecipient.findMany({where:{draftId:id,memberId:{in:[...affected]}}})
      await notification(tx,changed,existing.map(r=>r.memberId),'График изменён — требуется ознакомление','Ваши смены в «'+d.title+'» изменены. Предыдущий ответ относится к прошлой редакции.')
    }
    if(input.deadline && d.publishedAt) {const recipients=await tx.draftRecipient.findMany({where:{draftId:id}});await notification(tx,changed,recipients.map(r=>r.memberId),'Срок обсуждения изменён',d.title)}
    await history(tx,changed,actor,'PROPOSALS_CHANGED',{changes,affected:[...affected],confirmResponseWindow:input.confirmResponseWindow,deadline})
    return publicDraft(changed)
  })
}
async function validateDraftIn(tx:DB,actor:Actor,d:ScheduleDraft):Promise<DraftValidation> {
  const proposals=(await tx.draftShift.findMany({where:{draftId:d.id}})).map(proposal).filter(p=>p.kind!=='KEEP')
  const errors:DraftValidation['errors']=[], warnings:DraftValidation['warnings']=[]
  if(actor.location.archivedAt) errors.push({code:'LOCATION_ARCHIVED',message:'Точка закрыта.'})
  if(actor.organization.timezone!==d.timezone) errors.push({code:'DRAFT_TIMEZONE_CHANGED',message:'Часовой пояс точки изменился. Создайте новый график.'})
  const excluded=proposals.flatMap(p=>p.sourceShiftId?[p.sourceShiftId]:[])
  const additions=proposals.filter(p=>p.kind!=='CANCEL')
  for(const p of proposals) {
    try {
      if(p.sourceShiftId) {
        const source=await tx.workShift.findFirst({where:{id:p.sourceShiftId,organizationId:d.organizationId,locationId:d.locationId}})
        if(!source||source.status!=='SCHEDULED'||source.updatedAt.toISOString()!==p.source?.updatedAt) throw new ApiError(409,'SOURCE_CHANGED','Исходная смена изменилась, отменена или передана. Обновите исходную смену предложения либо уберите его.')
        if(source.scheduledStartAt<=new Date() || source.actualStartAt || source.actualEndAt || source.actualBreakMinutes!==null) throw new ApiError(409,'SHIFT_STARTED','Исходная смена уже началась или имеет фактическое время. Актуализируйте предложение.')
        await activeTarget(tx,d.organizationId,source.memberId,source.scheduledStartAt,source.scheduledEndAt)
        if(await tx.shiftOfferReservation.count({where:{shiftId:source.id}})) throw new ApiError(409,'SHIFT_HAS_OFFER','Смена участвует в передаче или обмене. Сначала завершите или отмените предложение.')
      }
      if(p.kind==='CANCEL') continue
      const s=p.proposed,start=new Date(s.scheduledStartAt),end=new Date(s.scheduledEndAt)
      if(start<=new Date()) throw new ApiError(409,'SHIFT_STARTED','Предлагаемая смена уже началась. Выберите будущую дату.')
      validateDuration(start,end,s.breakMinutes)
      await activeTarget(tx,d.organizationId,s.memberId,start,end)
      await assertNoApprovedAbsence(d.organizationId,s.memberId,start,end,d.timezone,tx)
      if(s.positionId && !await tx.organizationPosition.count({where:{id:s.positionId,organizationId:d.organizationId,isActive:true,members:{some:{memberId:s.memberId}}}})) throw new ApiError(400,'POSITION_NOT_ASSIGNED','Должность больше не назначена сотруднику или неактивна.')
      const conflict=await tx.workShift.findFirst({where:{organizationId:d.organizationId,memberId:s.memberId,status:'SCHEDULED',id:{notIn:excluded},scheduledStartAt:{lt:end},scheduledEndAt:{gt:start}}})
      const proposedConflict=additions.find(other=>other.id!==p.id && other.proposed.memberId===s.memberId && other.proposed.scheduledStartAt<s.scheduledEndAt && other.proposed.scheduledEndAt>s.scheduledStartAt)
      if(conflict||proposedConflict) throw new ApiError(409,'SHIFT_OVERLAP',shiftConflictMessage(conflict??proposedConflict!.proposed,d.timezone))
    } catch(error) {if(!(error instanceof ApiError))throw error;errors.push({code:error.code,message:p.proposed.memberName+' · '+displayDate(zonedDateAndTime(p.proposed.scheduledStartAt,d.timezone).date)+' · '+formatTime(p.proposed.scheduledStartAt,d.timezone)+'–'+formatTime(p.proposed.scheduledEndAt,d.timezone)+': '+error.message,proposalId:p.id})}
  }
  for(const memberId of new Set(additions.map(p=>p.proposed.memberId))) {
    const load=await checkMonthlyWorkload(tx,d.organizationId,memberId,d.timezone,actor.organization.monthlyWorkMinutes,additions.filter(p=>p.proposed.memberId===memberId).map(p=>({start:new Date(p.proposed.scheduledStartAt),end:new Date(p.proposed.scheduledEndAt)})),excluded,true)
    for(const w of load) warnings.push({code:'WORKLOAD_WARNING',message:(additions.find(p=>p.proposed.memberId===memberId)?.proposed.memberName??'Сотрудник')+': '+w.month+' — '+(w.minutes/60).toFixed(1)+' ч при норме '+(w.limit/60).toFixed(1)+' ч.'})
  }
  const picture=await workPicture(tx,actor,d,(await tx.draftShift.findMany({where:{draftId:d.id}})).map(proposal))
  const coverage=await coverageFor(tx,actor,dateText(d.fromDate),addCalendarDays(dateText(d.toDate),1),picture)
  const shortage=coverage.reduce((sum,day)=>sum+day.shortageIntervals,0),surplus=coverage.reduce((sum,day)=>sum+day.surplusIntervals,0)
  if(shortage||surplus) {
    const gaps=coverage.flatMap(day=>day.segments.filter(segment=>segment.shortage>0).map(segment=>`${displayDate(day.date)} · ${segment.positionName} · ${formatTime(segment.startAt,d.timezone)}–${formatTime(segment.endAt,d.timezone)}: назначено ${segment.assigned} из ${segment.needed}`))
    warnings.push({code:'COVERAGE_WARNING',message:shortage?`Не хватает сотрудников: ${gaps.slice(0,3).join('; ')}.${gaps.length>3?' Остальные даты смотрите в потребности.':''} Можно применить график и закрыть оставшиеся места позже.`:'Есть работа сверх заданной потребности. Посмотрите должности и часы в блоке потребности. Такие назначения можно сохранить.'})
  }
  return {errors,warnings,coverage}
}
export async function validateDraft(userId:string,organizationId:string,id:string) {
  return withDraft(userId,organizationId,id,undefined,async(tx,actor,d)=> {requirePermission(actor,'drafts.view');return validateDraftIn(tx,actor,d)})
}
async function refreshRecipients(tx:DB,_actor:Actor,d:ScheduleDraft) {
  const rows=await tx.draftShift.findMany({where:{draftId:d.id}}), proposals=rows.map(proposal)
  const from=startOfZonedDate(dateText(d.fromDate),d.timezone),to=startOfZonedDate(addCalendarDays(dateText(d.toDate),1),d.timezone)
  const members=await tx.organizationMember.findMany({where:{organizationId:d.organizationId,leftAt:null,user:{deletedAt:null},OR:[{locationMemberships:{some:{locationId:d.locationId,leftAt:null}}},{locationTransfers:{some:{toLocationId:d.locationId,temporary:true,startAt:{lt:to},endAt:{gt:from}}}}]},select:{id:true}})
  const eligible=new Set(members.map(m=>m.id))
  for(const p of proposals) for(const s of [p.source,p.proposed]) if(s) {try{await activeTarget(tx,d.organizationId,s.memberId,new Date(s.scheduledStartAt),new Date(s.scheduledEndAt));eligible.add(s.memberId)}catch(error){if(!(error instanceof ApiError))throw error}}
  const current=await tx.draftRecipient.findMany({where:{draftId:d.id}}),known=new Set(current.map(r=>r.memberId))
  const fresh=[...eligible].filter(id=>!known.has(id))
  if(fresh.length) await tx.draftRecipient.createMany({data:fresh.map(memberId=>({organizationId:d.organizationId,draftId:d.id,memberId,requiredRevision:d.revision}))})
  await notification(tx,d,fresh,'Новый график на согласование','Вам доступен предварительный график «'+d.title+'». Ознакомьтесь со своими сменами до окончания обсуждения.')
  return fresh
}
export async function actOnDraft(userId:string,organizationId:string,id:string,input:z.infer<typeof schemas.draftActionBody>) {
  const result=await withDraft(userId,organizationId,id,input.revision,async(tx,actor,d)=> {
    editable(d)
    requirePermission(actor,input.action==='APPLY'?'drafts.apply':'drafts.discuss')
    let status=d.status,deadline=d.deadline
    const now=new Date()
    if(input.action==='PUBLISH') {
      if(d.status!=='PREPARING')throw new ApiError(409,'DRAFT_PUBLISHED','Обсуждение уже объявлено.')
      const validation=await validateDraftIn(tx,actor,d)
      if(validation.errors.length)throw new ApiError(409,'DRAFT_CONFLICTS',validation.errors.map(e=>e.message).join(' '),validation)
      deadline=input.deadline?new Date(input.deadline):new Date(+now+actor.location.discussionHours*3600000)
      if(deadline<=now)throw new ApiError(400,'DEADLINE_PAST','Срок окончания должен быть в будущем.')
      status='OPEN'
    }
    if(input.action==='EXTEND') {
      if(!d.publishedAt||!input.deadline)throw new ApiError(400,'DEADLINE_REQUIRED','Укажите новый срок объявленного обсуждения.')
      deadline=new Date(input.deadline)
      if(deadline<=now || d.status==='OPEN' && d.deadline && deadline<=d.deadline)throw new ApiError(400,'DEADLINE_PAST','Новый срок должен быть позже текущего срока и текущего времени.')
      status='OPEN'
    }
    if(input.action==='CLOSE') {
      open(d)
      if(!input.confirm)throw new ApiError(400,'EXPLANATION_REQUIRED','Подтвердите завершение обсуждения. После этого график можно будет применить.')
      status='CLOSED'
    }
    if(input.action==='CANCEL') {
      if(!input.confirm||input.explanation.length<3)throw new ApiError(400,'EXPLANATION_REQUIRED','Подтвердите отмену и укажите причину.')
      status='CANCELLED'
    }
    if(input.action==='REFRESH_RECIPIENTS') {
      if(!d.publishedAt)throw new ApiError(400,'NOT_PUBLISHED','Сначала объявите обсуждение.')
      const added=await refreshRecipients(tx,actor,d)
      await history(tx,d,actor,'RECIPIENTS_ADDED',{memberIds:added})
      return {draft:publicDraft(d),effects:[],actor}
    }
    const effects:Awaited<ReturnType<typeof mutatePlannedShift>>[]=[]
    let snapshot:PublicShift[]|undefined
    if(input.action==='APPLY') {
      if(d.status!=='CLOSED')throw new ApiError(409,'DISCUSSION_NOT_CLOSED','Сначала завершите обсуждение. До срока требуется явное досрочное завершение с объяснением.')
      const proposals=(await tx.draftShift.findMany({where:{draftId:id}})).map(proposal)
      const changes=proposals.filter(p=>p.kind!=='KEEP')
      for(const p of changes)requirePermission(actor,p.kind==='CREATE'?'schedule.create':p.kind==='UPDATE'?'schedule.edit':'schedule.cancel')
      for(const shiftId of changes.flatMap(p=>p.sourceShiftId?[p.sourceShiftId]:[]).sort())await tx.$queryRaw`SELECT id FROM work_shifts WHERE id=${shiftId}::uuid FOR UPDATE`
      const validation=await validateDraftIn(tx,actor,d)
      if(validation.errors.length)throw new ApiError(409,'DRAFT_CONFLICTS',validation.errors.map(e=>e.message).join(' '),validation)
      if(validation.warnings.some(w=>w.code==='WORKLOAD_WARNING')&&!input.acknowledgeWorkload)throw new ApiError(409,'WORKLOAD_WARNING','Подтвердите применение с превышением месячной нормы.',validation)
      const openComments=await tx.draftComment.count({where:{draftId:id,status:'OPEN'}})
      if(openComments && (!input.confirm||input.explanation.length<3))throw new ApiError(400,'OPEN_COMMENTS','Есть открытые замечания. Подтвердите применение и укажите объяснение руководителя.')
      snapshot=await workPicture(tx,actor,d,proposals)
      await tx.$executeRaw`SET CONSTRAINTS work_shifts_no_overlap DEFERRED`
      for(const p of changes) {
        const current=p.sourceShiftId?await tx.workShift.findUniqueOrThrow({where:{id:p.sourceShiftId}}):undefined
        const s=p.proposed
        const effect=await mutatePlannedShift(tx,actor,p.kind==='CANCEL'?{current,reason:'Отмена по предварительному графику «'+d.title.slice(0,160)+'»'}:{current,input:{memberId:s.memberId,positionId:s.positionId,breakMinutes:s.breakMinutes,description:s.description,startDate:'',endDate:'',startTime:'',endTime:''},startAt:new Date(s.scheduledStartAt),endAt:new Date(s.scheduledEndAt)})
        effects.push(effect)
        await tx.draftShift.update({where:{id:p.id},data:{appliedShiftId:effect.changed.id}})
        if(p.kind!=='CANCEL')snapshot=snapshot.map(shift=>shift.id===s.id?{...s,id:effect.changed.id}:shift)
      }
      await tx.$executeRaw`SET CONSTRAINTS work_shifts_no_overlap IMMEDIATE`
      status='APPLIED'
    }
    const changed=await tx.scheduleDraft.update({where:{id},data:{status,deadline,revision:{increment:1},...(input.action==='PUBLISH'?{publishedAt:now}:{}),...(['APPLIED','CANCELLED'].includes(status)?{finishedAt:now,finishedByMemberId:actor.id}:{}),...(snapshot?{appliedSnapshot:json(snapshot)}:{})}})
    if(input.action==='PUBLISH')await refreshRecipients(tx,actor,changed)
    if(d.publishedAt && ['EXTEND','CLOSE','CANCEL'].includes(input.action)) {
      const recipients=await tx.draftRecipient.findMany({where:{draftId:id}})
      await notification(tx,changed,recipients.map(r=>r.memberId),input.action==='EXTEND'?'Срок обсуждения изменён':input.action==='CLOSE'?'Обсуждение завершено досрочно':'Обсуждение графика отменено',d.title+(input.explanation?' · '+input.explanation:''))
    }
    await history(tx,changed,actor,input.action,{explanation:input.explanation,confirm:input.confirm,deadline,snapshot: snapshot ?? null,changes:effects.map(e=>({shiftId:e.changed.id,notificationId:e.notification?.id}))})
    // Applied changes use only ordinary shift notifications, with no duplicate discussion result.
    return {draft:publicDraft(changed),effects,actor}
  })
  for(const effect of result.effects) {
    if(effect.notification)void sendImportantShiftEmail(effect.notification.id,effect.changed,effect.changed.member.user.email,result.actor.organization.name,result.actor.organization.timezone,effect.notification.type as 'SHIFT_ASSIGNED'|'SHIFT_CHANGED'|'SHIFT_CANCELLED').catch(error=>console.error('Shift email failed:',error))
    if(effect.previousAssignment) {const previous=effect.previousAssignment;void sendImportantShiftEmail(previous.notification.id,previous.shift,previous.shift.member.user.email,result.actor.organization.name,result.actor.organization.timezone,'SHIFT_CANCELLED').catch(error=>console.error('Shift email failed:',error))}
  }
  return result.draft
}
export async function respondToDraft(userId:string,organizationId:string,id:string,input:z.infer<typeof schemas.draftResponseBody>) {
  return withDraft(userId,organizationId,id,input.revision,async(tx,actor,d)=> {
    await accessible(tx,actor,d);open(d)
    const r=await tx.draftRecipient.findUnique({where:{draftId_memberId:{draftId:id,memberId:actor.id}}})
    if(!r)throw new ApiError(403,'NOT_A_PARTICIPANT','Вы не включены в обсуждение.')
    if(input.response==='NO_OBJECTIONS'&&await tx.draftComment.count({where:{draftId:id,memberId:actor.id,status:'OPEN'}}))throw new ApiError(409,'OWN_OPEN_COMMENT','Сначала отзовите свои открытые замечания или дождитесь решения руководителя.')
    const response=await tx.draftRecipient.update({where:{draftId_memberId:{draftId:id,memberId:actor.id}},data:{response:input.response,respondedRevision:r.requiredRevision,respondedAt:new Date()}})
    const proposals=(await tx.draftShift.findMany({where:{draftId:id}})).map(proposal)
    const seenShifts=(await workPicture(tx,actor,d,proposals)).filter(s=>s.memberId===actor.id)
    await history(tx,d,actor,'RESPONSE',{response:input.response,requiredRevision:r.requiredRevision,shifts:seenShifts})
    return response
  })
}
export async function commentOnDraft(userId:string,organizationId:string,id:string,input:z.infer<typeof schemas.draftCommentBody>) {
  return withDraft(userId,organizationId,id,input.revision,async(tx,actor,d)=> {
    const {recipient}=await accessible(tx,actor,d);open(d)
    if(!recipient)throw new ApiError(403,'NOT_A_PARTICIPANT','Вы не включены в обсуждение.')
    const proposals=(await tx.draftShift.findMany({where:{draftId:id}})).map(proposal)
    const p=input.proposalId?proposals.find(p=>p.id===input.proposalId):null
    if(input.proposalId&&(!p || p.proposed.memberId!==actor.id&&p.source?.memberId!==actor.id))throw new ApiError(403,'OWN_SHIFT_REQUIRED','Замечание можно оставить только к своей смене.')
    if(input.date&&(input.date<dateText(d.fromDate)||input.date>dateText(d.toDate)))throw new ApiError(400,'OUTSIDE_DRAFT_PERIOD','Дата должна входить в период графика.')
    const ownSnapshot=proposals.filter(p=>p.proposed.memberId===actor.id||p.source?.memberId===actor.id).map(p=>({id:p.id,kind:p.kind,proposed:p.proposed.memberId===actor.id?p.proposed:null,source:p.source?.memberId===actor.id?p.source:null}))
    const unchanged=(await workPicture(tx,actor,d,proposals)).filter(s=>s.memberId===actor.id && !ownSnapshot.some(p=>p.proposed?.id===s.id)).map(s=>({id:s.id,kind:'KEEP',proposed:s,source:null}))
    const comment=await tx.draftComment.create({data:{organizationId,draftId:id,memberId:actor.id,proposalId:p?.id,date:input.date?new Date(input.date):null,revision:recipient.requiredRevision,snapshot:json(p?ownSnapshot.filter(s=>s.id===p.id):[...ownSnapshot,...unchanged].filter(s=>!input.date || s.proposed?.scheduledStartAt && new Date(s.proposed.scheduledStartAt)>=startOfZonedDate(input.date,d.timezone) && new Date(s.proposed.scheduledStartAt)<startOfZonedDate(addCalendarDays(input.date,1),d.timezone))),text:input.text}})
    await tx.draftRecipient.update({where:{draftId_memberId:{draftId:id,memberId:actor.id}},data:{response:'OBJECTIONS',respondedRevision:recipient.requiredRevision,respondedAt:new Date()}})
    await history(tx,d,actor,'COMMENT_CREATED',{commentId:comment.id,text:input.text,proposalId:p?.id,revision:recipient.requiredRevision})
    return comment
  })
}
export async function decideDraftComment(userId:string,organizationId:string,id:string,commentId:string,input:z.infer<typeof schemas.draftDecisionBody>) {
  return withDraft(userId,organizationId,id,undefined,async(tx,actor,d)=> {
    await accessible(tx,actor,d);editable(d)
    const c=await tx.draftComment.findFirst({where:{id:commentId,draftId:id}})
    if(!c)throw new ApiError(404,'COMMENT_NOT_FOUND','Замечание не найдено.')
    if(c.status!=='OPEN')throw new ApiError(409,'COMMENT_CLOSED','По замечанию уже есть решение.')
    if(input.action==='WITHDRAWN') {open(d);if(c.memberId!==actor.id)throw new ApiError(403,'OWN_COMMENT_REQUIRED','Можно отозвать только своё замечание.')}
    else {requirePermission(actor,'drafts.resolve');if(input.text.length<3)throw new ApiError(400,'EXPLANATION_REQUIRED','Укажите комментарий к решению.')}
    const result=await tx.draftComment.update({where:{id:commentId},data:{status:input.action,decision:input.text||null,decidedByMemberId:actor.id,decidedAt:new Date()}})
    await history(tx,d,actor,'COMMENT_'+input.action,{commentId,text:input.text,memberId:c.memberId})
    if(input.action!=='WITHDRAWN')await notification(tx,d,[c.memberId],'Ответ на замечание к графику',input.text)
    return result
  })
}
// Used by notification history without relying on the currently selected sidebar point.
export async function canReadDraftNotification(userId:string,organizationId:string,id:string) {
  const actor=await getMembership(userId,organizationId)
  const d=await prisma.scheduleDraft.findFirst({where:{id,organizationId}})
  if(!d)return false
  if(hasPermission(actor,'drafts.view',d.locationId))return true
  return !!d.publishedAt && !!await prisma.draftRecipient.count({where:{draftId:id,memberId:actor.id}})
}
