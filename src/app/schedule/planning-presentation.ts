import type { DemandData, DemandInterval, CoverageDay } from './team-planning-types.ts'
import { addDays, calendarRange } from './date-utils.ts'
export function demandOnDate(data: DemandData, date: string): { source: 'exception' | 'template' | 'unconfigured'; intervals: DemandInterval[] | null } {
  const exception = data.exceptions.find(day => day.date === date)
  if (exception) return { source: 'exception', intervals: exception.intervals }
  const version = [...data.versions].reverse().find(version => version.effectiveFrom <= date)
  const intervals = version?.days[(new Date(`${date}T12:00Z`).getUTCDay()+6)%7] ?? null
  return { source: intervals === null ? 'unconfigured' : 'template', intervals }
}
export function monthDates(month: string) { return calendarRange(month).days.filter(day => day.startsWith(month)) }
export function weekDates(date: string) {
  const monday = addDays(date,-((new Date(`${date}T12:00Z`).getUTCDay()+6)%7))
  return Array.from({length:7},(_,index)=>addDays(monday,index))
}
// The source week always includes Monday through Sunday, including its past days.
// Only the start of the new repetition is clamped to today; historical dates are not rewritten.
export function buildDemandCycle(data: DemandData, anchor: string, today: string, edits: Record<string, DemandInterval[] | null> = {}) {
  const dates = weekDates(anchor)
  return { dates, effectiveFrom: dates[0] < today ? today : dates[0], days: dates.map(date => structuredClone(Object.hasOwn(edits,date) ? edits[date] : demandOnDate(data,date).intervals)) }
}
export function coverageLabel(day: CoverageDay) {
  return day.shortageIntervals ? 'Нужны сотрудники' : day.surplusIntervals ? 'Работают сверх потребности' : day.source === 'unconfigured' ? 'Потребность не задана' : day.noDemand ? 'День без потребности' : 'Все рабочие места закрыты'
}
