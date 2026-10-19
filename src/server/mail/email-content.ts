import type { EmailDelivery } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { type EmailContent } from './transport.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { hasPermission } from '../organizations/access/access.ts'
import { isUrgentShiftEmail } from '../organizations/notification-service.ts'
import { canReadDraftNotification } from '../schedule/planning/team-planning-service.ts'
import { canReadDocument, getDocument } from '../documents/service.ts'
import { getEvent } from '../events/service.ts'
import { canReadCustom, stageReviewers } from '../requests/workflow.ts'
import { addDays, zonedDateAndTime } from '../../app/schedule/date-utils.ts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown) => typeof value === 'string' ? value : ''
const person = (u: { firstName: string | null; lastName: string | null; email: string }) => [u.lastName, u.firstName].filter(Boolean).join(' ') || 'Сотрудник'
const date = (value: Date, zone: string) => value.toLocaleDateString('ru-RU', { timeZone: zone, day: 'numeric', month: 'long', year: 'numeric' })
const stamp = (value: Date, zone: string) => value.toLocaleString('ru-RU', { timeZone: zone, dateStyle: 'long', timeStyle: 'short' })
const period = (start: Date, end: Date, zone: string) => `${stamp(start, zone)} — ${stamp(end, zone)} (${zone === 'Europe/Moscow' ? 'МСК' : zone})`
function jsonContent(value: unknown): EmailContent | null {
  const p = record(value)
  if (!str(p.title) || !str(p.intro)) return null
  return p as unknown as EmailContent
}
export async function buildDeliveryContent(job: EmailDelivery, now: Date): Promise<EmailContent | null> {
  if (job.sourceKind === 'MANDATORY') return jsonContent(job.payload)
  if (!job.organizationId) return null
  try { return await buildWorkEmail(job, now) } catch (error) { if (error instanceof ApiError && [403,404].includes(error.status)) return null; throw error }
}
async function buildWorkEmail(job: EmailDelivery, now: Date): Promise<EmailContent | null> {
  const actor = await getMembership(job.userId, job.organizationId!)
  const base = `/app/organizations/${job.organizationId}`, org = actor.organization.name
  const make = (content: EmailContent): EmailContent => ({ ...content, optional: true, organization: org })
  const point = async (id?: string | null) => id ? prisma.organizationLocation.findFirst({ where: { id, organizationId: job.organizationId! } }) : null
  if (job.sourceKind === 'DRAFT_REVIEW') {
    const draft = await prisma.scheduleDraft.findFirst({ where: { id: job.sourceId!, organizationId: actor.organizationId, status: 'CLOSED' }, include: { location: true } })
    if (!draft || draft.location.archivedAt || draft.revision !== record(job.payload).revision || !hasPermission(actor,'drafts.resolve',draft.locationId) || !await canReadDraftNotification(job.userId,actor.organizationId,draft.id)) return null
    return make({ title: 'График ожидает вашего решения', eyebrow: 'Согласование графика', intro: 'Обсуждение завершено. Проверьте ответы команды и примите решение по графику.', fields: [['График',draft.title], ['Организация и точка',`${org} · ${draft.location.name}`], ['Период',`${date(draft.fromDate,'UTC')} — ${date(draft.toDate,'UTC')}`]], action: { label: 'Рассмотреть график', path: `${base}/schedule/drafts/${draft.id}?location=${draft.locationId}` } })
  }
  if (job.sourceKind === 'SCHEDULE') {
    const draft = await prisma.scheduleDraft.findFirst({ where: { id: job.sourceId!, organizationId: actor.organizationId, status: 'APPLIED' }, include: { location: true } })
    if (!draft || !hasPermission(actor,'schedule.own',draft.locationId)) return null
    const from = draft.fromDate.toISOString().slice(0,10), to = draft.toDate.toISOString().slice(0,10)
    const shifts = await prisma.workShift.findMany({ where: { memberId: actor.id, organizationId: actor.organizationId, locationId: draft.locationId, status: 'SCHEDULED', scheduledStartAt: { gte: new Date(+draft.fromDate - 86400_000), lt: new Date(+draft.toDate + 2*86400_000) } }, orderBy: { scheduledStartAt: 'asc' } })
    const own = shifts.filter(s => { const day = zonedDateAndTime(s.scheduledStartAt.toISOString(),draft.timezone).date; return day >= from && day <= to })
    return make({ title: 'Ваш график опубликован', eyebrow: 'Расписание', intro: `${org} · ${draft.location.name}\n${date(draft.fromDate,'UTC')} — ${date(draft.toDate,'UTC')}`, fields: [...own.slice(0,8).map(s => [date(s.scheduledStartAt,draft.timezone), period(s.scheduledStartAt,s.scheduledEndAt,draft.timezone)] as [string,string]), ['Всего смен', String(own.length)]], action: { label: 'Открыть весь график', path: `${base}/schedule?view=mine&month=${from.slice(0,7)}&location=${draft.locationId}` } })
  }
  if (job.sourceKind === 'DOCUMENT_REMINDER') {
    const ack = await prisma.documentAcknowledgement.findUnique({ where: { id: job.sourceId! }, include: { document: true, member: true } })
    if (!ack || ack.member.userId !== job.userId || ack.acknowledgedAt || ack.cancelledAt || !ack.deadline || ack.document.deletedAt || !canReadDocument(actor,ack.document)) return null
    await getDocument(job.userId,actor.organizationId,ack.documentId)
    const p = await point(ack.document.locationId)
    const tomorrow = addDays(zonedDateAndTime(now.toISOString(),p?.timezone ?? actor.organization.timezone).date,1)
    if (ack.deadline.toISOString().slice(0,10) !== tomorrow) return null
    return make({ title: 'Завтра срок ознакомления', eyebrow: 'Документы', intro: 'Вы ещё не подтвердили ознакомление с документом.', fields: [['Документ', ack.document.displayName], ['Срок', date(ack.deadline,'UTC')], ['Организация и точка', org + (p ? ` · ${p.name}` : '')]], action: { label: 'Ознакомиться', path: `${base}/documents?document=${ack.documentId}${p ? `&location=${p.id}` : ''}` } })
  }
  if (job.sourceKind === 'DRAFT_REMINDER') {
    const draft = await prisma.scheduleDraft.findFirst({ where: { id: job.sourceId!, organizationId: actor.organizationId, status: 'OPEN', deadline: { gt: now } }, include: { recipients: { where: { memberId: actor.id } }, location: true } })
    const recipient = draft?.recipients[0]
    if (!draft || !recipient || recipient.response && recipient.respondedRevision === recipient.requiredRevision || !await canReadDraftNotification(job.userId,actor.organizationId,draft.id)) return null
    return make({ title: 'Ответьте по графику', eyebrow: 'Согласование', intro: 'Ваш ответ по текущей редакции ещё не получен.', fields: [['График', draft.title], ['Точка', draft.location.name], ['Ответить до', stamp(draft.deadline!,draft.timezone)]], action: { label: 'Оставить ответ', path: `${base}/schedule/drafts/${draft.id}?location=${draft.locationId}` } })
  }
  if (job.sourceKind === 'VACATION_REMINDER') {
    const campaign = await prisma.vacationCampaign.findFirst({ where: { id: job.sourceId!, organizationId: actor.organizationId, closedAt: null, dueAt: { gt: now } }, include: { requests: { where: { createdByMemberId: actor.id }, select: { id: true } } } })
    if (!campaign || !campaign.memberIds.includes(actor.id) || campaign.requests.length || !hasPermission(actor,'requests.own',campaign.locationId)) return null
    const p = await point(campaign.locationId)
    return make({ title: 'Не забудьте выбрать даты', eyebrow: 'Пожелания на отпуск', intro: 'Пожелания ещё не отправлены. До конца сбора — один день.', fields: [['Сбор', campaign.title], ['Год', String(campaign.year)], ['Срок', stamp(campaign.dueAt,p?.timezone ?? actor.organization.timezone)]], action: { label: 'Выбрать даты', path: `${base}/requests?tab=vacations&year=${campaign.year}&campaign=${campaign.id}${p ? `&location=${p.id}` : ''}` } })
  }
  if (job.sourceKind !== 'NOTIFICATION') return null
  const n = await prisma.accountNotification.findFirst({ where: { id: job.sourceId!, userId: job.userId, organizationId: actor.organizationId }, include: { shift: true, request: true, document: true, vacationCampaign: true, scheduleDraft: true, shiftOffer: { include: { sourceShift: true, targetShift: true } }, event: { include: { recipients: true, locations: true } }, absence: { include: { member: { include: { user: true, locationMemberships: { where: { leftAt: null } } } } } } } })
  if (!n || n.hiddenAt || +now - +n.createdAt > 2*86400_000) return null
  if (job.category === 'actionDigest' && n.type === 'REQUEST_CREATED' && n.request) {
    const r = n.request, permission = r.systemCodeSnapshot === 'VACATION' ? 'vacations.resolve' : ['STAFFING','STAFFING_RESPONSE'].includes(r.systemCodeSnapshot ?? '') ? 'staffing.resolve' : 'requests.resolve'
    if (r.status !== 'PENDING' || !hasPermission(actor,permission,r.locationId) || r.createdByMemberId === actor.id && !hasPermission(actor,'requests.selfResolve',r.locationId)) return null
    if ((!r.systemCodeSnapshot || r.systemCodeSnapshot === 'VACATION') && !(await stageReviewers(prisma,r)).some(reviewer => reviewer.id === actor.id)) return null
    const p = await point(r.locationId)
    if (!p || p.archivedAt) return null
    return make({ title: 'Заявка ожидает вашего решения', eyebrow: 'Заявки', intro: 'Поступила заявка, по которой требуется ваше решение.', fields: [['Тип заявки',r.typeNameSnapshot], ['Организация и точка',`${org} · ${p.name}`], ...(r.startDate ? [['Период',date(r.startDate,'UTC') + (r.endDate ? ` — ${date(r.endDate,'UTC')}` : '')] as [string,string]] : [])], action: { label: 'Рассмотреть заявку', path: `${base}/requests?tab=incoming&request=${r.id}&location=${r.locationId}` } })
  }
  if (job.category === 'actionDigest' && n.type === 'SHIFT_OFFER_APPROVAL' && n.shiftOffer) {
    const o = n.shiftOffer
    if (o.status !== 'AWAITING_APPROVAL' || [o.initiatorMemberId,o.acceptedByMemberId].includes(actor.id) || !hasPermission(actor,'offers.approve',o.locationId)) return null
    const p = await point(o.locationId)
    if (!p || p.archivedAt) return null
    return make({ title: 'Нужно согласовать смены', eyebrow: 'Предложения смен', intro: 'Коллега принял предложение. Проверьте его и примите решение.', fields: [['Организация и точка',`${org} · ${p.name}`], ['Исходная смена',period(o.sourceShift.scheduledStartAt,o.sourceShift.scheduledEndAt,p.timezone)], ...(o.targetShift ? [['Встречная смена',period(o.targetShift.scheduledStartAt,o.targetShift.scheduledEndAt,p.timezone)] as [string,string]] : [])], action: { label: 'Рассмотреть предложение', path: `${base}/requests?tab=offers&offer=${o.id}&location=${o.locationId}` } })
  }
  if (n.shift && job.category === 'shiftChanges') {
    const s = n.shift, context = record(n.emailContext), before = record(context.previous)
    const location = await point(s.locationId)
    if (!location || location.archivedAt || !hasPermission(actor,'schedule.own',s.locationId)) return null
    const start = new Date(str(context.startAt) || s.scheduledStartAt), end = new Date(str(context.endAt) || s.scheduledEndAt)
    const previousStart = str(before.startAt) ? new Date(str(before.startAt)) : null, previousEnd = str(before.endAt) ? new Date(str(before.endAt)) : null
    if (!isUrgentShiftEmail(start,end,now) && !(previousStart && previousEnd && isUrgentShiftEmail(previousStart,previousEnd,now))) return null
    if (n.type !== 'SHIFT_CANCELLED' && (s.memberId !== actor.id || s.status !== 'SCHEDULED' || s.scheduledEndAt <= now)) return null
    const fields: Array<[string,string]> = [['Организация и точка', `${org} · ${location.name}`]]
    if (n.type === 'SHIFT_CHANGED' && previousStart && previousEnd) fields.push(['Было', period(previousStart,previousEnd,location.timezone)])
    fields.push([n.type === 'SHIFT_CHANGED' ? 'Стало' : 'Смена',period(start,end,location.timezone)])
    if (str(context.position) || s.positionNameSnapshot) fields.push(['Должность',str(context.position) || s.positionNameSnapshot!])
    if (str(context.reason)) fields.push(['Причина',str(context.reason)])
    if (str(context.actorMemberId)) { const initiator = await prisma.organizationMember.findFirst({ where:{id:str(context.actorMemberId),organizationId:actor.organizationId},include:{user:true} }); if(initiator)fields.push(['Изменил',person(initiator.user)]) }
    if (str(before.position) && str(before.position) !== (str(context.position) || s.positionNameSnapshot)) fields.push(['Прежняя должность',str(before.position)])
    const titles = { SHIFT_ASSIGNED: 'Вам назначена смена', SHIFT_CHANGED: 'Ваша смена изменена', SHIFT_CANCELLED: 'Ваша смена отменена' }
    return make({ title: titles[n.type as keyof typeof titles], eyebrow: 'Расписание', intro: n.type === 'SHIFT_CANCELLED' ? 'Смена отменена. Проверьте обновлённое расписание.' : 'Ваше расписание обновлено.', fields, ...(n.type === 'SHIFT_CANCELLED' ? { badge: { text: 'Отменена', tone: 'warning' as const } } : {}), action: { label: n.type === 'SHIFT_CANCELLED' ? 'Открыть расписание' : 'Открыть смену', path: `${base}/schedule?view=mine&month=${zonedDateAndTime(start.toISOString(),location.timezone).date.slice(0,7)}&shift=${s.id}&location=${s.locationId}` } })
  }
  if (n.request && job.category === 'requestResults') {
    const r = n.request
    if (r.createdByMemberId !== actor.id || !['APPROVED','REJECTED'].includes(r.status) || r.status !== n.type.replace('REQUEST_','') || !hasPermission(actor,'requests.own',r.locationId)) return null
    if (!r.systemCodeSnapshot && !await canReadCustom(prisma,actor,r)) return null
    const p = await point(r.locationId), approved = r.status === 'APPROVED'
    return make({ title: approved ? 'Заявка одобрена' : 'Заявка отклонена', eyebrow: 'Заявки', intro: r.resolutionComment || 'По вашей заявке принято окончательное решение.', badge: { text: approved ? 'Одобрена' : 'Отклонена', tone: approved ? 'success' : 'warning' }, fields: [['Тип заявки',r.typeNameSnapshot], ['Организация и точка',org + (p ? ` · ${p.name}` : '')], ...(r.startDate ? [['Период',date(r.startDate,'UTC') + (r.endDate ? ` — ${date(r.endDate,'UTC')}` : '')] as [string,string]] : [])], action: { label: 'Открыть заявку', path: `${base}/requests?tab=mine&request=${r.id}${p ? `&location=${p.id}` : ''}` } })
  }
  if (n.document && job.category === 'documents') {
    const d = n.document
    const ack = await prisma.documentAcknowledgement.findUnique({ where: { documentId_memberId: { documentId: d.id, memberId: actor.id } } })
    if (!ack || ack.cancelledAt || ack.acknowledgedAt || d.deletedAt || !canReadDocument(actor,d)) return null
    await getDocument(job.userId,actor.organizationId,d.id)
    const p = await point(d.locationId)
    return make({ title: 'Ознакомьтесь с документом', eyebrow: 'Документы', intro: 'Вам назначено обязательное ознакомление.', fields: [['Документ',d.displayName], ['Организация и точка',org + (p ? ` · ${p.name}` : '')], ...(ack.deadline ? [['Срок',date(ack.deadline,'UTC')] as [string,string]] : [])], action: { label: 'Открыть документ', path: `${base}/documents?document=${d.id}${p ? `&location=${p.id}` : ''}` } })
  }
  if (n.event && job.category === 'importantEvents') {
    const e = n.event
    if (!e.important || !e.recipients.some(r => r.memberId === actor.id && !r.removedAt) || (e.endAt ?? e.startAt) <= now) return null
    if (e.cancelledAt && n.type !== 'EVENT_CANCELLED' || !e.cancelledAt && n.type === 'EVENT_CANCELLED') return null
    const event = await getEvent(job.userId,actor.organizationId,e.id)
    const p = event.locations.find(l => !l.archivedAt)
    const fields: Array<[string,string]> = [['Событие',e.title],['Когда',e.endAt ? period(e.startAt,e.endAt,e.timezone) : stamp(e.startAt,e.timezone)], ['Организация и точки',org + (event.shared ? ' · Вся организация' : ' · ' + event.locations.map(l=>l.name).join(', '))]]
    if (n.type === 'EVENT_CHANGED') {
      const previous = await prisma.eventChange.findFirst({ where: { eventId:e.id, revision: { lt:e.revision } }, orderBy: { revision:'desc' } })
      const snapshot = record(previous?.snapshot)
      if (str(snapshot.startAt)) fields.splice(1,0,['Было',stamp(new Date(str(snapshot.startAt)),e.timezone)])
    }
    if (e.place) fields.push(['Место',e.place])
    return make({ title: n.type === 'EVENT_CANCELLED' ? 'Событие отменено' : n.type === 'EVENT_CHANGED' ? 'Событие изменено' : 'Вас приглашают на событие', eyebrow: 'Важное событие', intro: n.type === 'EVENT_CANCELLED' ? 'Планы изменились: событие отменено.' : 'Событие для команды отмечено как важное.', fields, action: { label: 'Открыть событие', path: `${base}/events?event=${e.id}${p ? `&location=${p.id}` : ''}` } })
  }
  if (n.scheduleDraft && job.category === 'scheduleDiscussion') {
    const d = n.scheduleDraft
    if (!['Новый график на согласование','График изменён — требуется ознакомление'].includes(n.title) || d.status !== 'OPEN' || !await canReadDraftNotification(job.userId,actor.organizationId,d.id)) return null
    const recipient = await prisma.draftRecipient.findUnique({ where: { draftId_memberId: { draftId:d.id,memberId:actor.id } } })
    if (!recipient || recipient.response && recipient.requiredRevision === recipient.respondedRevision) return null
    const p = await point(d.locationId)
    return make({ title: n.title.startsWith('График изменён') ? 'Проверьте новую редакцию графика' : 'Проверьте ваш график', eyebrow: 'Согласование', intro: 'Проверьте свои смены и оставьте ответ.', fields: [['График',d.title], ['Точка',p?.name ?? org], ...(d.deadline ? [['Ответить до',stamp(d.deadline,d.timezone)] as [string,string]] : [])], action: { label: 'Посмотреть график', path: `${base}/schedule/drafts/${d.id}?location=${d.locationId}` } })
  }
  if (n.vacationCampaign && job.category === 'vacationCollection') {
    const c = n.vacationCampaign
    if (c.closedAt || c.dueAt <= now || !c.memberIds.includes(actor.id) || !hasPermission(actor,'requests.own',c.locationId)) return null
    if (await prisma.organizationRequest.count({ where: { vacationCampaignId:c.id,createdByMemberId:actor.id } })) return null
    const p = await point(c.locationId)
    return make({ title: 'Укажите пожелания на отпуск', eyebrow: 'Планирование отпусков', intro: 'Выберите предпочтительные даты отпуска.', fields: [['Сбор',c.title],['Год',String(c.year)],['Ответить до',stamp(c.dueAt,p?.timezone ?? actor.organization.timezone)]], action: { label:'Указать пожелания',path:`${base}/requests?tab=vacations&year=${c.year}&campaign=${c.id}${p ? `&location=${p.id}` : ''}` } })
  }
  if (n.shiftOffer && job.category === 'shiftOffers') {
    const o = n.shiftOffer, incoming = n.type === 'SHIFT_OFFER_CREATED'
    if (![o.initiatorMemberId,o.recipientMemberId,o.acceptedByMemberId].includes(actor.id) || !hasPermission(actor,'schedule.own',o.locationId)) return null
    if (incoming && (o.recipientMemberId !== actor.id || o.status !== 'PENDING' || !hasPermission(actor,'offers.accept',o.locationId) || !isUrgentShiftEmail(o.sourceShift.scheduledStartAt,o.sourceShift.scheduledEndAt,now))) return null
    if (!incoming && !['COMPLETED','REJECTED','CANCELLED','EXPIRED','INVALID'].includes(o.status)) return null
    const p = await point(o.locationId)
    if (!p || p.archivedAt) return null
    const completed = o.status === 'COMPLETED'
    return make({ title: incoming ? 'Вам предложили смену' : completed ? o.kind === 'SWAP' ? 'Обмен сменами подтверждён' : 'Передача смены подтверждена' : 'Предложение закрыто', eyebrow: 'Предложения смен', intro: incoming ? 'Вам адресовано предложение. Рассмотрите его в Staffly.' : completed ? 'Ваше расписание обновлено.' : `${o.resolutionReason || 'Предложение больше не действует.'} Ваш график не изменён.`, fields: [['Организация и точка',`${org} · ${p.name}`], ['Исходная смена',period(o.sourceShift.scheduledStartAt,o.sourceShift.scheduledEndAt,p.timezone)], ...(o.targetShift ? [['Встречная смена',period(o.targetShift.scheduledStartAt,o.targetShift.scheduledEndAt,p.timezone)] as [string,string]] : [])], action: { label:incoming ? 'Рассмотреть предложение' : 'Открыть предложение',path:`${base}/requests?tab=offers&offer=${o.id}&location=${o.locationId}` } })
  }
  if (n.absence && job.category === 'urgentAbsences') {
    const a = n.absence
    if (a.cancelledAt || a.member.leftAt || a.memberId === actor.id || !hasPermission(actor,'absences.view')) return null
    const shifts = await prisma.workShift.findMany({ where: { organizationId:actor.organizationId,memberId:a.memberId,status:'SCHEDULED',scheduledStartAt:{lte:new Date(+now+86400_000)},scheduledEndAt:{gt:now} }, include:{location:true},orderBy:{scheduledStartAt:'asc'} })
    const shift = shifts.find(s => hasPermission(actor,'absences.view',s.locationId) && hasPermission(actor,'schedule.view',s.locationId) && (()=>{const day=zonedDateAndTime(s.scheduledStartAt.toISOString(),s.location.timezone).date;return day>=a.startDate.toISOString().slice(0,10)&&day<=a.endDate.toISOString().slice(0,10)})())
    if (!shift) return null
    return make({ title:'На ближайшую смену нет сотрудника',eyebrow:'Команда',intro:'Сотрудник сообщил об отсутствии. Проверьте покрытие смены.',fields:[['Сотрудник',person(a.member.user)],['Организация и точка',`${org} · ${shift.location.name}`],['Смена',period(shift.scheduledStartAt,shift.scheduledEndAt,shift.location.timezone)]],action:{label:'Проверить расписание',path:`${base}/schedule?location=${shift.locationId}&shift=${shift.id}`} })
  }
  return null
}
