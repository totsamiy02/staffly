import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'
import {
  calculateVacationBalance, vacationBalanceSetup, vacationBalanceChange, addVacationDays, roundVacationDays,
  type VacationBalance, type VacationBalanceHistoryItem, type VacationServiceMode,
} from '../../shared/vacation-balance.ts'
import { vacationDays } from '../../shared/request-workflow.ts'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { hasPermission, requirePermission, locationsFor } from '../organizations/access/access.ts'
import { requirePlanFeature, requireSubscriptionWritable } from '../subscriptions/access.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { dateTimeParts } from '../../shared/date-time.ts'

type DB = Prisma.TransactionClient

type Actor = Awaited<ReturnType<typeof getMembership>>
const iso = (value: Date) => value.toISOString().slice(0, 10)
const name = (user: { firstName: string | null; lastName: string | null; middleName?: string | null }) =>
  [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || 'Сотрудник'
const dateAt = (value: Date, timezone: string) => {
  const parts = dateTimeParts(value, timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}
const dayAt = (actor: Actor) => dateAt(new Date(), actor.organization.timezone)
const inputHash = (memberId: string, input: unknown) => createHash('sha256').update(JSON.stringify({ memberId, input })).digest('hex')

export const balanceListQuery = z.object({
  search: z.string().trim().max(100).default(''),
  locationId: z.uuid().optional(),
  state: z.enum(['all', 'unconfigured', 'available', 'exceeded']).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
})

async function actorFor(db: DB, userId: string, organizationId: string) {
  const actor = await getMembership(userId, organizationId, db)
  return actor
}

function targetWhere(actor: Actor, memberId?: string, manage = false): Prisma.OrganizationMemberWhereInput {
  const permission = manage ? 'vacations.balances.manage' : 'vacations.balances.view'
  const points = locationsFor(actor, permission)
  return {
    organizationId: actor.organizationId,
    id: memberId,
    leftAt: null,
    user: { deletedAt: null },
    ...(actor.owner ? {} : {
      OR: [
        ...(!manage && memberId === actor.id ? [{ id: actor.id }] : []),
        { locationMemberships: { some: { locationId: { in: points }, leftAt: null, location: { archivedAt: null } } } },
      ]
    }),
  }
}

async function requireTarget(db: DB, actor: Actor, memberId: string, manage = false) {
  if (!manage && actor.id === memberId && !hasPermission(actor, 'vacations.balances.view')) requirePermission(actor, 'requests.own')
  else requirePermission(actor, manage ? 'vacations.balances.manage' : 'vacations.balances.view')
  const target = await db.organizationMember.findFirst({
    where: targetWhere(actor, memberId, manage),
    include: {
      employmentPeriods: { where: { endedAt: null }, take: 1 },
    }
  })
  if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Сотрудник недоступен.')
  return target
}

export async function balancesFor(db: DB, actor: Actor, memberIds: string[], asOf = dayAt(actor), proposed?: { memberId: string; absenceId?: string; startDate: string; endDate: string }) {
  if (!memberIds.length) return new Map<string, VacationBalance>()
  const [accounts, absences, requests] = await Promise.all([
    db.vacationAccount.findMany({
      where: { organizationId: actor.organizationId, memberId: { in: memberIds }, employmentPeriod: { endedAt: null } },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }
    }),
    db.employeeAbsence.findMany({
      where: {
        organizationId: actor.organizationId,
        memberId: { in: memberIds },
        cancelledAt: null,
        OR: [{ type: 'VACATION' }, { vacationService: { not: 'INCLUDED' } }]
      }
    }),
    db.organizationRequest.findMany({
      where: {
        organizationId: actor.organizationId,
        createdByMemberId: { in: memberIds },
        systemCodeSnapshot: 'VACATION',
        status: 'PENDING'
      },
      select: { createdByMemberId: true, startDate: true, endDate: true }
    }),
  ])
  return new Map(memberIds.map(memberId => {
    const account = accounts.find(item => item.memberId === memberId)
    const balance = calculateVacationBalance({
      asOf,
      standardDays: actor.organization.vacationStandardDays,
      holidays: actor.organization.vacationHolidays,
      account: account ? { ...account, employmentStartDate: iso(account.employmentStartDate) } : null,
      events: account?.events.map(event => ({
        ...event,
        effectiveDate: iso(event.effectiveDate),
        amount: event.amountHundredths === null ? null : event.amountHundredths / 100
      })),
      absences: [
        ...absences.filter(item => item.memberId === memberId && item.id !== proposed?.absenceId).map(item => ({
          id: item.id,
          type: item.type,
          startDate: iso(item.startDate),
          endDate: iso(item.endDate),
          serviceMode: item.vacationService as VacationServiceMode,
        })),
        ...(proposed?.memberId === memberId ? [{ id: 'proposal', type: 'VACATION', startDate: proposed.startDate, endDate: proposed.endDate }] : [])
      ],
      pending: requests.filter(item => item.createdByMemberId === memberId && item.startDate && item.endDate)
        .map(item => ({ startDate: iso(item.startDate!), endDate: iso(item.endDate!) })),
    })
    return [memberId, balance]
  }))
}

export async function getVacationBalance(userId: string, organizationId: string, memberId?: string, preview?: { startDate?: string; endDate?: string; requestId?: string }) {
  return prisma.$transaction(async db => {
    const actor = await actorFor(db, userId, organizationId)
    const target = await requireTarget(db, actor, memberId ?? actor.id)
    await requirePlanFeature(organizationId, 'vacationBalances', db)
    const balance = (await balancesFor(db, actor, [target.id])).get(target.id)!
    if (!preview?.startDate || !preview.endDate) return { balance }
    const request = preview.requestId ? await db.organizationRequest.findFirst({
      where: { id: preview.requestId, organizationId, createdByMemberId: target.id, systemCodeSnapshot: 'VACATION' },
      select: { absence: { select: { id: true } }, amendmentOfId: true },
    }) : null
    if (preview.requestId && !request) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Заявка недоступна.')
    const originalAbsence = request?.amendmentOfId ? await db.employeeAbsence.findFirst({
      where: { organizationId, memberId: target.id, sourceRequestId: request.amendmentOfId, cancelledAt: null },
      select: { id: true }
    }) : null
    const proposed = {
      memberId: target.id,
      startDate: preview.startDate,
      endDate: preview.endDate,
      absenceId: request?.absence?.id ?? originalAbsence?.id
    }
    const after = (await balancesFor(db, actor, [target.id], balance.asOf, proposed)).get(target.id)!
    return {
      balance,
      days: vacationDays(preview.startDate, preview.endDate, actor.organization.vacationHolidays),
      availableAfterApproval: after.available
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function listVacationBalances(userId: string, organizationId: string, query: z.infer<typeof balanceListQuery>) {
  return prisma.$transaction(async db => {
    const actor = await actorFor(db, userId, organizationId)
    requirePermission(actor, 'vacations.balances.view')
    await requirePlanFeature(organizationId, 'vacationBalances', db)
    if (query.locationId && !actor.owner && !locationsFor(actor, 'vacations.balances.view').includes(query.locationId)) {
      throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Остатки этой точки недоступны.')
    }
    const members = await db.organizationMember.findMany({
      where: {
        AND: [
          targetWhere(actor),
          ...(query.locationId ? [{ locationMemberships: { some: { locationId: query.locationId, leftAt: null } } }] : [])
        ]
      },
      include: {
        user: { select: { firstName: true, lastName: true, middleName: true, avatarFileId: true } },
        positions: { include: { position: { select: { name: true } } } },
        locationMemberships: {
          where: { leftAt: null, location: { archivedAt: null } },
          include: { location: { select: { name: true } } }
        },
      },
      orderBy: { id: 'asc' },
    })
    const search = query.search.toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean)
    const found = members.filter(member => search.every(term => {
      const email = member.locationMemberships.some(point => hasPermission(actor, 'members.contacts', point.locationId)) ? member.workEmail ?? '' : ''
      return `${name(member.user)} ${email}`.toLocaleLowerCase('ru-RU').includes(term)
    })).sort((a, b) => name(a.user).localeCompare(name(b.user), 'ru'))
    const balances = await balancesFor(db, actor, found.map(member => member.id))
    const rows = found.map(member => ({
      memberId: member.id,
      name: name(member.user),
      avatarUrl: mediaUrl(member.user.avatarFileId),
      positions: member.positions.map(item => item.position.name),
      locations: member.locationMemberships.filter(point => actor.owner || hasPermission(actor, 'vacations.balances.view', point.locationId))
        .map(point => ({ id: point.locationId, name: point.location.name })),
      canManage: actor.owner || member.locationMemberships.some(point => hasPermission(actor, 'vacations.balances.manage', point.locationId)),
      balance: balances.get(member.id)!,
    })).filter(row => query.state === 'all' || query.state === 'unconfigured' && !row.balance.configured
      || query.state === 'available' && (row.balance.available ?? 0) > 0
      || query.state === 'exceeded' && row.balance.available !== null && row.balance.available < 0)
    const pages = Math.max(1, Math.ceil(rows.length / 20))
    const page = Math.min(query.page, pages)
    return {
      members: rows.slice((page - 1) * 20, page * 20),
      pagination: { page, pages, total: rows.length },
      standardDays: actor.organization.vacationStandardDays
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 20000 })
}

async function replay(db: DB, actor: Actor, memberId: string, key: string, hash: string) {
  const entry = await db.vacationBalanceEvent.findUnique({
    where: { organizationId_submissionKey: { organizationId: actor.organizationId, submissionKey: key } },
    include: { account: { include: { employmentPeriod: { select: { endedAt: true } } } } }
  })
  if (!entry) return null
  if (entry.account.employmentPeriod.endedAt || entry.actorMemberId !== actor.id || entry.account.memberId !== memberId || entry.inputHash !== hash) {
    throw new ApiError(409, 'VACATION_OPERATION_CHANGED', 'Этот запрос уже использован для другого изменения.')
  }
  return { balance: (await balancesFor(db, actor, [memberId])).get(memberId)! }
}

export async function setupVacationBalance(userId: string, organizationId: string, memberId: string, raw: z.input<typeof vacationBalanceSetup>) {
  const input = vacationBalanceSetup.parse(raw)
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const actor = await actorFor(db, userId, organizationId)
    const target = await requireTarget(db, actor, memberId, true)
    await requirePlanFeature(organizationId, 'vacationBalances', db)
    await requireSubscriptionWritable(db, organizationId)
    const today = dayAt(actor), hash = inputHash(memberId, input)
    const repeated = await replay(db, actor, memberId, input.submissionKey, hash)
    if (repeated) return repeated
    if (input.employmentStartDate > today || input.openingDate && input.openingDate > today) {
      throw new ApiError(400, 'VACATION_DATE_FUTURE', 'Дата приёма и переноса остатка не могут быть в будущем.')
    }
    const period = target.employmentPeriods[0]
    if (!period) throw new ApiError(409, 'EMPLOYMENT_PERIOD_MISSING', 'Действующий период работы не найден.')
    if (await db.vacationAccount.findUnique({ where: { employmentPeriodId: period.id } })) {
      throw new ApiError(409, 'VACATION_ACCOUNT_EXISTS', 'Учёт уже настроен. Используйте корректировку.')
    }
    // A restored member starts a new account; never import prior employment silently.
    const earlier = await db.memberEmploymentPeriod.count({ where: { organizationId, memberId, endedAt: { not: null } } })
    if (earlier && period.startedAt && input.employmentStartDate < dateAt(period.startedAt, actor.organization.timezone)) {
      throw new ApiError(400, 'VACATION_REHIRE_DATE', 'Для повторного приёма укажите дату нового периода работы.')
    }
    const account = await db.vacationAccount.create({
      data: {
        organizationId,
        memberId,
        employmentPeriodId: period.id,
        employmentStartDate: new Date(input.employmentStartDate),
        annualDays: input.annualDays ?? actor.organization.vacationStandardDays,
      }
    })
    await db.vacationBalanceEvent.create({
      data: {
        organizationId,
        accountId: account.id,
        actorMemberId: actor.id,
        kind: 'START',
        effectiveDate: new Date(input.employmentStartDate),
        annualDays: account.annualDays,
        reason: input.reason,
        submissionKey: input.submissionKey,
        inputHash: hash,
        snapshot: { employmentStartDate: input.employmentStartDate, annualDays: account.annualDays },
      }
    })
    if (input.openingDate && input.openingDays !== undefined) {
      await db.vacationBalanceEvent.create({
        data: {
          organizationId,
          accountId: account.id,
          actorMemberId: actor.id,
          kind: 'OPENING',
          effectiveDate: new Date(input.openingDate),
          amountHundredths: Math.round(input.openingDays * 100),
          reason: input.reason,
          submissionKey: randomUUID(),
          inputHash: hash,
          snapshot: { after: input.openingDays },
        }
      })
    }
    return { balance: (await balancesFor(db, actor, [memberId])).get(memberId)! }
  })
}

export async function changeVacationBalance(userId: string, organizationId: string, memberId: string, raw: z.input<typeof vacationBalanceChange>) {
  const input = vacationBalanceChange.parse(raw)
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},1))::text`
    const actor = await actorFor(db, userId, organizationId)
    const target = await requireTarget(db, actor, memberId, true)
    await requirePlanFeature(organizationId, 'vacationBalances', db)
    await requireSubscriptionWritable(db, organizationId)
    const hash = inputHash(memberId, input)
    const repeated = await replay(db, actor, memberId, input.submissionKey, hash)
    if (repeated) return repeated
    const before = (await balancesFor(db, actor, [memberId])).get(memberId)!
    if (!before.accountId) throw new ApiError(409, 'VACATION_ACCOUNT_MISSING', 'Сначала укажите дату приёма для автоматического учёта.')
    if (before.revision !== input.revision) throw new ApiError(409, 'VACATION_BALANCE_CHANGED', 'Остаток уже изменён. Обновите данные перед сохранением.')
    if (input.kind === 'EMPLOYMENT') {
      if (input.employmentStartDate > before.asOf || before.openingDate && input.employmentStartDate > before.openingDate) {
        throw new ApiError(400, 'VACATION_EMPLOYMENT_DATE', 'Дата приёма не может быть позже текущей даты или переноса прежнего остатка.')
      }
      const closedPeriods = await db.memberEmploymentPeriod.count({ where: { organizationId, memberId, endedAt: { not: null } } })
      const startedAt = target.employmentPeriods[0]?.startedAt
      if (closedPeriods && startedAt && input.employmentStartDate < dateAt(startedAt, actor.organization.timezone)) {
        throw new ApiError(400, 'VACATION_REHIRE_DATE', 'Укажите дату текущего периода работы.')
      }
    }
    await db.vacationAccount.update({
      where: { id: before.accountId },
      data: {
        revision: { increment: 1 },
        ...(input.kind === 'EMPLOYMENT' ? { employmentStartDate: new Date(input.employmentStartDate) } : {}),
      }
    })
    // Today-only changes preserve previously credited months and keep the audit immutable.
    await db.vacationBalanceEvent.create({
      data: {
        organizationId,
        accountId: before.accountId,
        actorMemberId: actor.id,
        kind: input.kind,
        effectiveDate: new Date(input.kind === 'POLICY' ? addVacationDays(before.asOf, 1) : before.asOf),
        amountHundredths: input.kind === 'ADJUSTMENT' ? Math.round(input.amount * 100) : null,
        annualDays: input.kind === 'POLICY' ? input.annualDays : null,
        reason: input.reason,
        submissionKey: input.submissionKey,
        inputHash: hash,
        snapshot: {
          before: before.remaining,
          annualDaysBefore: before.annualDays,
          employmentStartDateBefore: before.employmentStartDate,
          ...(input.kind === 'EMPLOYMENT' ? { employmentStartDate: input.employmentStartDate } : {})
        },
      }
    })
    return { balance: (await balancesFor(db, actor, [memberId])).get(memberId)! }
  })
}

export async function vacationBalanceHistory(userId: string, organizationId: string, memberId: string, page = 1) {
  return prisma.$transaction(async db => {
    const actor = await actorFor(db, userId, organizationId)
    await requireTarget(db, actor, memberId)
    await requirePlanFeature(organizationId, 'vacationBalances', db)
    const balance = (await balancesFor(db, actor, [memberId])).get(memberId)!
    const [entries, absences] = await Promise.all([
      db.vacationBalanceEvent.findMany({
        where: { organizationId, account: { memberId } },
        include: { actor: { select: { user: { select: { firstName: true, lastName: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      db.employeeAbsence.findMany({
        where: { organizationId, memberId, type: 'VACATION' },
        include: {
          sourceRequest: {
            select: {
              id: true,
              resolvedAt: true,
              resolvedBy: { select: { user: { select: { firstName: true, lastName: true } } } },
              events: {
                where: { type: { in: ['CHANGED', 'CANCELLED'] } },
                include: { actor: { select: { user: { select: { firstName: true, lastName: true } } } } }
              }
            }
          }
        }
      }),
    ])
    const titles: Record<string, string> = {
      START: 'Начат автоматический учёт',
      OPENING: 'Перенесён прежний остаток',
      ADJUSTMENT: 'Корректировка остатка',
      POLICY: 'Изменена годовая норма',
      EMPLOYMENT: 'Уточнена дата приёма'
    }
    const history: VacationBalanceHistoryItem[] = entries.map(entry => {
      const snapshot = entry.snapshot as {
        before?: number | null
        after?: number | null
        employmentStartDate?: string
        employmentStartDateBefore?: string
      }
      return {
        id: entry.id,
        type: entry.kind,
        title: titles[entry.kind],
        date: entry.createdAt.toISOString(),
        actor: name(entry.actor.user),
        reason: `${entry.reason}${entry.kind === 'START' ? ` · Приём: ${iso(entry.effectiveDate)} · Норма: ${entry.annualDays} дн./год` : entry.kind === 'OPENING' ? ` · На ${iso(entry.effectiveDate)}` : entry.kind === 'POLICY' ? ` · ${entry.annualDays} дн./год с ${iso(entry.effectiveDate)}` : entry.kind === 'EMPLOYMENT' ? ` · ${snapshot.employmentStartDateBefore} → ${snapshot.employmentStartDate}` : ''}`,
        amount: entry.amountHundredths === null ? null : entry.amountHundredths / 100,
        before: snapshot.before,
        after: entry.kind === 'ADJUSTMENT' && snapshot.before !== undefined && snapshot.before !== null
          ? roundVacationDays(snapshot.before + (entry.amountHundredths ?? 0) / 100)
          : snapshot.after,
      }
    })
    for (const absence of absences) {
      const source = absence.sourceRequest
      history.push({
        id: absence.id,
        type: 'VACATION',
        title: absence.cancelledAt ? 'Отпуск отменён' : iso(absence.endDate) < balance.asOf ? 'Использован отпуск' : 'Согласован отпуск',
        date: (absence.cancelledAt ?? source?.resolvedAt ?? absence.createdAt).toISOString(),
        actor: source?.resolvedBy ? name(source.resolvedBy.user) : 'Зарегистрированное отсутствие',
        reason: `${iso(absence.startDate)} — ${iso(absence.endDate)}`,
        amount: null,
        requestId: source?.id
      })
      for (const event of source?.events ?? []) history.push({
        id: event.id,
        type: 'VACATION_CHANGE',
        title: 'Изменение отпуска',
        date: event.createdAt.toISOString(),
        actor: name(event.actor.user),
        reason: event.comment ?? 'Период отпуска изменён',
        amount: null,
        requestId: source?.id
      })
    }
    const serviceChanges = await db.accessAudit.findMany({
      where: { organizationId, action: 'VACATION_SERVICE_CHANGED', details: { path: ['memberId'], equals: memberId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const authors = await db.organizationMember.findMany({
      where: { organizationId, id: { in: serviceChanges.map(item => item.actorMemberId) } },
      select: { id: true, user: { select: { firstName: true, lastName: true } } },
    })
    for (const entry of serviceChanges) {
      const details = entry.details as {
        reason: string
        before: { mode: string; startDate: string; endDate: string }
        after: { mode: string; startDate: string; endDate: string; cancelled: boolean }
      }
      const author = authors.find(item => item.id === entry.actorMemberId)
      history.push({
        id: entry.id,
        type: 'SERVICE',
        title: 'Изменён отпускной стаж',
        date: entry.createdAt.toISOString(),
        actor: author ? name(author.user) : 'Бывший участник',
        amount: null,
        reason: `${details.reason} · ${details.after.startDate} — ${details.after.endDate}${details.after.cancelled ? ' · Отсутствие отменено' : ''}`
      })
    }
    const accounts = await db.vacationAccount.findMany({
      where: { organizationId, memberId },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, employmentPeriod: true },
    })
    const serviceAbsences = await db.employeeAbsence.findMany({ where: { organizationId, memberId, cancelledAt: null, vacationService: { not: 'INCLUDED' } } })
    for (const account of accounts) {
      calculateVacationBalance({
        asOf: account.employmentPeriod.endedAt ? dateAt(account.employmentPeriod.endedAt, actor.organization.timezone) : balance.asOf,
        standardDays: account.annualDays,
        account: { ...account, employmentStartDate: iso(account.employmentStartDate) },
        events: account.events.map(event => ({
          ...event,
          effectiveDate: iso(event.effectiveDate),
          amount: event.amountHundredths === null ? null : event.amountHundredths / 100
        })),
        absences: serviceAbsences.map(absence => ({
          ...absence,
          startDate: iso(absence.startDate),
          endDate: iso(absence.endDate),
          serviceMode: absence.vacationService as VacationServiceMode
        })),
        onAccrual: credit => history.push({
          id: `${account.id}:${credit.date}`,
          type: 'ACCRUAL',
          title: 'Начисление за месяц стажа',
          date: new Date(`${credit.date}T00:00:00Z`).toISOString(),
          actor: 'Автоматический расчёт',
          reason: `Годовая норма ${credit.annualDays} дн. ÷ 12. Отпуска и исключённые периоды учитываются отдельно.`,
          amount: Math.round(credit.days * 100) / 100
        }),
      })
    }
    history.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    const pages = Math.max(1, Math.ceil(history.length / 15))
    const currentPage = Math.min(page, pages)
    return {
      balance,
      items: history.slice((currentPage - 1) * 15, currentPage * 15),
      pagination: { page: currentPage, total: history.length, pages }
    }
  }, { isolationLevel: 'RepeatableRead', timeout: 20000 })
}
