import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestSections } from '../src/app/requests/navigation.ts'
import { vacationsOnDay } from '../src/app/requests/vacation-calendar.ts'
import type { OrganizationSummary } from '../src/app/organizations/types.ts'

const organization = { id: 'org', owner: true } as OrganizationSummary
describe('request navigation and vacation calendar', () => {
  it('keeps personal requests first and auxiliary processes last', () => {
    const sections = requestSections(organization)
    assert.equal(sections[0].id, 'mine')
    assert.deepEqual(sections.slice(-2).map(section => section.id), ['vacations', 'offers'])
  })
  it('allows a custom role to enter only the processes granted to it', () => {
    assert.deepEqual(requestSections({ ...organization, owner: false, permissions: ['offers.approve'] }).map(section => section.id), ['offers'])
    assert.deepEqual(requestSections({ ...organization, owner: false, permissions: ['vacations.view'] }).map(section => section.id), ['vacations'])
  })
  it('shows approved overlaps without counting an amendment twice', () => {
    const base = { memberId: 'alice', currentStartDate: '2027-07-01', currentEndDate: '2027-07-14', cancelled: false }
    const periods = [
      { ...base, id: 'approved', status: 'APPROVED' as const },
      { ...base, id: 'amendment', status: 'PENDING' as const },
      { ...base, memberId: 'bob', id: 'bob', status: 'APPROVED' as const },
      { ...base, memberId: 'carol', id: 'cancelled', cancelled: true, status: 'APPROVED' as const },
      { ...base, memberId: 'dave', id: 'pending', status: 'PENDING' as const },
    ]
    assert.deepEqual(vacationsOnDay(periods, '2027-07-05').map(p => p.id), ['approved', 'bob'])
    assert.deepEqual(vacationsOnDay(periods, '2027-07-05', true).map(p => p.id), ['approved', 'bob', 'pending'])
    assert.equal(vacationsOnDay(periods, '2027-07-15').length, 0)
  })
})
