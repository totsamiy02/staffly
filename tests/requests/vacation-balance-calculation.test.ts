import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { calculateVacationBalance, vacationMonthDate, vacationBalanceSetup } from '../../src/shared/vacation-balance.ts'
const account = { id: 'account', revision: 1, employmentStartDate: '2025-01-15', annualDays: 28 }
const calculate = (extra: Partial<Parameters<typeof calculateVacationBalance>[0]> = {}) =>
  calculateVacationBalance({ asOf: '2026-01-15', standardDays: 28, account, ...extra })
describe('automatic vacation balance calculation', () => {
  it('requires a real employment date instead of inventing a 28-day current balance', () => {
    const result = calculate({ account: null })
    assert.equal(result.configured, false)
    assert.equal(result.remaining, null)
    assert.equal(result.annualDays, 28)
  })
  it('accrues exact annual fractions over complete service months with no January reset', () => {
    assert.equal(calculate({ asOf: '2025-02-14' }).accrued, 0)
    assert.equal(calculate({ asOf: '2025-02-15' }).accrued, 2.33)
    assert.equal(calculate({ asOf: '2025-07-15' }).accrued, 14)
    assert.equal(calculate().accrued, 28)
    assert.equal(calculate({ asOf: '2027-01-15' }).remaining, 56)
    assert.equal(calculate({ asOf: '2026-01-01' }).accrued, 25.67)
  })
  it('anchors leap-day and month-end anniversaries without drifting', () => {
    assert.equal(vacationMonthDate('2024-02-29', 12), '2025-02-28')
    assert.equal(vacationMonthDate('2025-01-31', 1), '2025-02-28')
    assert.equal(vacationMonthDate('2025-01-31', 2), '2025-03-31')
    assert.equal(calculate({ asOf: '2025-02-28', account: { ...account, employmentStartDate: '2024-02-29' } }).remaining, 28)
  })
  it('separates used, reserved and pending days; custom holidays and cancelled absences count correctly', () => {
    const result = calculate({
      asOf: '2026-11-16',
      events: [{ kind: 'OPENING', effectiveDate: '2026-11-01', amount: 20, annualDays: null }],
      holidays: ['2026-11-06'],
      absences: [
        { id: 'used', type: 'VACATION', startDate: '2026-11-04', endDate: '2026-11-06' },
        { id: 'future', type: 'VACATION', startDate: '2026-11-23', endDate: '2026-11-29' },
        { id: 'cancelled', type: 'VACATION', startDate: '2026-11-10', endDate: '2026-11-12', cancelled: true },
      ],
      pending: [{ startDate: '2026-12-21', endDate: '2026-12-23' }],
    })
    // Nov 15 credit is after the imported baseline: 20 + 28/12 - 1 used.
    assert.equal(result.used, 1)
    assert.equal(result.reserved, 7)
    assert.equal(result.pending, 3)
    assert.equal(result.remaining, 21.33)
    assert.equal(result.available, 14.33)
  })
  it('splits a running vacation at the current day and respects an imported balance date inclusively', () => {
    const result = calculate({
      asOf: '2026-01-15',
      events: [
        { kind: 'OPENING', effectiveDate: '2026-01-14', amount: 10, annualDays: null },
        { kind: 'ADJUSTMENT', effectiveDate: '2026-01-14', amount: 2, annualDays: null },
      ],
      absences: [{ id: 'running', type: 'VACATION', startDate: '2026-01-12', endDate: '2026-01-18' }]
    })
    assert.equal(result.used, 1)
    assert.equal(result.reserved, 3)
    assert.equal(result.remaining, 13.33)
    assert.equal(result.available, 10.33)
  })
  it('does not deduct old usage or old accrual a second time after importing history', () => {
    const result = calculate({
      asOf: '2026-01-15',
      events: [{ kind: 'OPENING', effectiveDate: '2026-01-15', amount: 18, annualDays: null }],
      absences: [{ id: 'old', type: 'VACATION', startDate: '2025-07-01', endDate: '2025-07-14' }]
    })
    assert.equal(result.remaining, 18)
    assert.equal(result.used, 0)
  })
  it('moves service anniversaries for explicitly excluded periods and keeps sickness included', () => {
    const absences = [
      {
        id: 'excluded',
        type: 'ABSENCE',
        startDate: '2025-01-15',
        endDate: '2025-01-24',
        serviceMode: 'EXCLUDED' as const
      },
      { id: 'sick', type: 'SICK', startDate: '2025-02-01', endDate: '2025-02-14' },
    ]
    assert.equal(calculate({ asOf: '2026-01-15', absences }).serviceMonths, 11)
    assert.equal(calculate({ asOf: '2026-01-25', absences }).accrued, 28)
    assert.equal(calculate({ asOf: '2026-01-25', absences }).excludedDays, 10)
  })
  it('includes only 14 unpaid days per shifted working year, rather than per calendar year', () => {
    const absences = [{
      id: 'unpaid',
      type: 'DAY_OFF',
      startDate: '2025-02-01',
      endDate: '2025-02-20',
      serviceMode: 'UNPAID' as const
    }]
    assert.equal(calculate({ absences }).excludedDays, 6)
    assert.equal(calculate({ asOf: '2026-01-21', absences }).serviceMonths, 12)
    const nextYear = [
      ...absences,
      {
        id: 'unpaid-next',
        type: 'DAY_OFF',
        startDate: '2026-01-21',
        endDate: '2026-02-03',
        serviceMode: 'UNPAID' as const
      }
    ]
    assert.equal(calculate({ asOf: '2026-03-01', absences: nextYear }).excludedDays, 6)
  })
  it('anchors the next working year to its shifted start across a leap day', () => {
    const result = calculate({
      account: { ...account, employmentStartDate: '2023-01-31' },
      asOf: '2025-03-11',
      absences: [{ id: 'excluded', type: 'ABSENCE', startDate: '2023-02-01', endDate: '2023-03-12', serviceMode: 'EXCLUDED' }],
    })
    assert.equal(result.excludedDays, 40)
    assert.equal(result.serviceMonths, 24)
    assert.equal(result.workYearStart, '2025-03-11')
    assert.equal(result.accrued, 56)
  })
  it('preserves past credits when the annual norm changes and permits an advance balance', () => {
    const result = calculate({
      events: [{ kind: 'POLICY', effectiveDate: '2025-07-16', amount: null, annualDays: 36 }],
      absences: [{ id: 'planned', type: 'VACATION', startDate: '2026-02-01', endDate: '2026-03-01' }]
    })
    assert.equal(result.accrued, 32)
    assert.equal(result.annualDays, 36)
    assert.equal(result.available, 4) // 29 calendar days less February 23.
  })
  it('rejects an incomplete or malformed previous balance import', () => {
    const input = { submissionKey: randomUUID(), reason: 'По данным бухгалтерии', employmentStartDate: '2025-01-01' }
    assert.equal(vacationBalanceSetup.safeParse({ ...input, openingDate: '2026-01-01' }).success, false)
    assert.equal(vacationBalanceSetup.safeParse({ ...input, openingDays: 18 }).success, false)
    assert.equal(vacationBalanceSetup.safeParse({ ...input, openingDate: '2024-01-01', openingDays: 18 }).success, false)
    assert.equal(vacationBalanceSetup.safeParse({ ...input, openingDate: '2026-01-01', openingDays: 18.001 }).success, false)
  })
})
