import { z } from 'zod'
import { vacationDays } from './request-workflow.ts'

export const vacationServiceModes = ['INCLUDED', 'UNPAID', 'EXCLUDED'] as const

export type VacationServiceMode = typeof vacationServiceModes[number]

export const vacationServiceLabels: Record<VacationServiceMode, string> = {
  INCLUDED: 'Входит в отпускной стаж',
  UNPAID: 'Без сохранения зарплаты — до 14 дней за рабочий год входят в стаж',
  EXCLUDED: 'Не входит в отпускной стаж',
}
const date = z.iso.date().refine(value => value >= '1900-01-01' && value <= '2200-12-31')
const days = z.number().finite().min(-10000).max(10000)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, 'Укажите не больше двух знаков после запятой.')
const common = {
  submissionKey: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
}

export const vacationBalanceSetup = z.object({
  ...common,
  employmentStartDate: date,
  annualDays: z.number().int().min(28).max(366).optional(),
  openingDate: date.optional(),
  openingDays: days.optional(),
}).strict().superRefine((input, context) => {
  if (!!input.openingDate !== (input.openingDays !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Укажите дату и остаток из прежнего учёта вместе.' })
  }
  if (input.openingDate && input.openingDate < input.employmentStartDate) {
    context.addIssue({ code: 'custom', path: ['openingDate'], message: 'Перенос не может быть раньше приёма на работу.' })
  }
})

export const vacationBalanceChange = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('ADJUSTMENT'),
    revision: z.number().int().positive(),
    amount: days.refine(value => value !== 0)
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('EMPLOYMENT'),
    revision: z.number().int().positive(),
    employmentStartDate: date
  }).strict(),
  z.object({
    ...common,
    kind: z.literal('POLICY'),
    revision: z.number().int().positive(),
    annualDays: z.number().int().min(28).max(366)
  }).strict(),
])

export type VacationBalance = {
  configured: boolean
  asOf: string
  annualDays: number
  employmentStartDate: string | null
  accountId: string | null
  revision: number
  accrued: number
  used: number
  adjustments: number
  remaining: number | null
  reserved: number
  pending: number
  available: number | null
  serviceMonths: number
  excludedDays: number
  workYearStart: string | null
  openingDate: string | null
  openingBalance: number | null
}

export type VacationBalanceRow = {
  memberId: string
  name: string
  avatarUrl: string | null
  positions: string[]
  locations: Array<{ id: string; name: string }>
  canManage: boolean
  balance: VacationBalance
}

export type VacationBalanceHistoryItem = {
  id: string
  type: string
  title: string
  date: string
  actor: string
  reason: string
  amount: number | null
  requestId?: string | null
  before?: number | null
  after?: number | null
}

export type BalanceAbsence = {
  id: string
  startDate: string
  endDate: string
  type: string
  cancelled?: boolean
  serviceMode?: VacationServiceMode
}

export type BalanceEvent = {
  kind: string
  effectiveDate: string
  amount: number | null
  annualDays: number | null
}
const DAY = 86400000
const instant = (value: string) => Date.parse(value + 'T00:00:00Z')

export const addVacationDays = (value: string, days: number) => new Date(instant(value) + days * DAY).toISOString().slice(0, 10)

export const roundVacationDays = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export function vacationMonthDate(start: string, months: number) {
  const value = new Date(instant(start))
  const day = value.getUTCDate()
  value.setUTCDate(1)
  value.setUTCMonth(value.getUTCMonth() + months)
  const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()
  value.setUTCDate(Math.min(day, last))
  return value.toISOString().slice(0, 10)
}
/** Calendar dates and exact annualDays / 12 credits; never add rounded 2.33 repeatedly. */
export function calculateVacationBalance(input: {
  asOf: string
  standardDays: number
  account?: { id: string; revision: number; employmentStartDate: string; annualDays: number } | null
  events?: BalanceEvent[]
  absences?: BalanceAbsence[]
  pending?: Array<{ startDate: string; endDate: string }>
  holidays?: string[]
  onAccrual?: (credit: { date: string; days: number; annualDays: number }) => void
}): VacationBalance {
  const { account, asOf, standardDays, holidays = [] } = input
  const absences = (input.absences ?? []).filter(item => !item.cancelled)
  const reserved = absences.filter(item => item.type === 'VACATION').reduce((total, item) => {
    const start = item.startDate > asOf ? item.startDate : addVacationDays(asOf, 1)
    return total + (start <= item.endDate ? vacationDays(start, item.endDate, holidays) : 0)
  }, 0)
  const pending = (input.pending ?? []).reduce((total, item) => total + vacationDays(item.startDate, item.endDate, holidays), 0)
  const base: VacationBalance = {
    configured: !!account,
    asOf,
    annualDays: account?.annualDays ?? standardDays,
    employmentStartDate: account?.employmentStartDate ?? null,
    accountId: account?.id ?? null,
    revision: account?.revision ?? 0,
    accrued: 0,
    used: 0,
    adjustments: 0,
    remaining: null,
    reserved,
    pending,
    available: null,
    serviceMonths: 0,
    excludedDays: 0,
    workYearStart: null,
    openingDate: null,
    openingBalance: null,
  }
  if (!account) return base
  const start = account.employmentStartDate
  const events = input.events ?? []
  const opening = events.find(event => event.kind === 'OPENING' && event.effectiveDate <= asOf)
  const rates = events.filter(event => event.kind === 'POLICY').sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
  const rateAt = (day: string) => rates.filter(rate => rate.effectiveDate <= day).at(-1)?.annualDays ?? account.annualDays
  let months = 0, excludedDays = 0, unpaidDays = 0
  let accrued = 0, afterOpening = 0, workYearStart = start
  const excluded = absences.filter(item => item.serviceMode === 'EXCLUDED' || item.serviceMode === 'UNPAID')
  function creditMonth(creditDate: string) {
    const annualDays = rateAt(creditDate)
    const credit = annualDays / 12
    accrued += credit
    if (!opening || creditDate > opening.effectiveDate) {
      afterOpening += credit
      input.onAccrual?.({ date: creditDate, days: credit, annualDays })
    }
  }
  const elapsedExclusions = excluded.filter(item => item.startDate < asOf && item.endDate >= start)
  if (!elapsedExclusions.length) {
    let yearStart = start
    while (yearStart <= asOf) {
      let credited = 0
      for (let month = 1; month <= 12; month++) {
        const creditDate = vacationMonthDate(yearStart, month)
        if (creditDate > asOf) break
        creditMonth(creditDate)
        months++
        credited++
      }
      if (credited < 12) break
      yearStart = vacationMonthDate(yearStart, 12)
      workYearStart = yearStart
    }
  } else {
    const modes = new Map<number, VacationServiceMode>()
    for (const absence of elapsedExclusions) {
      const first = Math.max(instant(start), instant(absence.startDate))
      const last = Math.min(instant(asOf) - DAY, instant(absence.endDate))
      for (let day = first; day <= last; day += DAY) {
        if (modes.get(day) !== 'EXCLUDED') modes.set(day, absence.serviceMode!)
      }
    }
    let eligibleInYear = 0, monthInYear = 0
    let yearStartInstant = instant(start)
    let nextMonthDays = (instant(vacationMonthDate(workYearStart, 1)) - yearStartInstant) / DAY
    // Each completed working year starts the next calendar anchor. Reusing the
    // original hire anchor would count a leap day in the wrong shifted year.
    for (let day = instant(start); day < instant(asOf); day += DAY) {
      const mode = modes.get(day)
      if (mode === 'UNPAID') unpaidDays++
      if (mode === 'EXCLUDED' || mode === 'UNPAID' && unpaidDays > 14) {
        excludedDays++
        continue
      }
      eligibleInYear++
      if (eligibleInYear < nextMonthDays) continue
      const creditDate = new Date(day + DAY).toISOString().slice(0, 10)
      months++
      monthInYear++
      creditMonth(creditDate)
      if (monthInYear === 12) {
        workYearStart = creditDate
        yearStartInstant = day + DAY
        eligibleInYear = 0
        monthInYear = 0
        unpaidDays = 0
      }
      nextMonthDays = (instant(vacationMonthDate(workYearStart, monthInYear + 1)) - yearStartInstant) / DAY
    }
  }
  const usageStart = opening ? addVacationDays(opening.effectiveDate, 1) : start
  const used = absences.filter(item => item.type === 'VACATION').reduce((total, item) => {
    const first = item.startDate > usageStart ? item.startDate : usageStart
    const last = item.endDate < asOf ? item.endDate : asOf
    return total + (first <= last ? vacationDays(first, last, holidays) : 0)
  }, 0)
  const adjustments = events.filter(event => event.kind === 'ADJUSTMENT' && event.effectiveDate <= asOf
    && (!opening || event.effectiveDate >= opening.effectiveDate)).reduce((sum, event) => sum + (event.amount ?? 0), 0)
  const remaining = roundVacationDays((opening?.amount ?? 0) + afterOpening + adjustments - used)
  return {
    ...base,
    annualDays: rateAt(asOf),
    accrued: roundVacationDays(opening ? afterOpening : accrued),
    used,
    adjustments: roundVacationDays(adjustments),
    remaining,
    available: roundVacationDays(remaining - reserved),
    serviceMonths: months,
    excludedDays,
    workYearStart,
    openingDate: opening?.effectiveDate ?? null,
    openingBalance: opening?.amount ?? null,
  }
}
