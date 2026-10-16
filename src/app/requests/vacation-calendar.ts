import type { RequestStatus } from './types.ts'
type Period = { memberId: string; status: RequestStatus; cancelled: boolean; currentStartDate: string; currentEndDate: string }
/** A pending amendment must not count a colleague twice or appear approved. */
export function vacationsOnDay<T extends Period>(periods: T[], date: string, includePending = false): T[] {
  const visible = periods.filter(p => !p.cancelled && (p.status === 'APPROVED' || includePending && ['PENDING', 'RETURNED'].includes(p.status)) && p.currentStartDate <= date && p.currentEndDate >= date)
  const members = new Map<string, T>()
  for (const period of visible) if (!members.has(period.memberId) || period.status === 'APPROVED') members.set(period.memberId, period)
  return [...members.values()]
}
export function vacationColor(memberId: string) { return [...memberId].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0) % 6 }
