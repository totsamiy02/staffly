import type { DemandDay, DemandInterval, DemandWeek, CoverageDay, CoverageSegment } from '../../../app/schedule/planning/team-planning-types.ts'
import { addCalendarDays, startOfZonedDate, zonedDateTimeToUtc } from '../timezone.ts'
import { ApiError } from '../../api-error.ts'
export type DemandVersionInput = { effectiveFrom: string; days: DemandWeek }
export type DemandExceptionInput = { date: string; intervals: DemandInterval[] }
export type CoverageShift = { attendance?:string;actualStartAt?:string|Date|null;actualEndAt?:string|Date|null; memberId: string; positionId?: string | null; scheduledStartAt: string | Date; scheduledEndAt: string | Date; status: string }
export function demandForDate(date: string, versions: DemandVersionInput[], exceptions: DemandExceptionInput[]) {
  const exception = exceptions.find(item => item.date === date)
  if (exception) return { source: 'exception' as const, intervals: exception.intervals }
  const version = [...versions].reverse().find(item => item.effectiveFrom <= date)
  const intervals = version?.days[(new Date(`${date}T00:00Z`).getUTCDay() + 6) % 7] ?? null
  return { source: intervals === null ? 'unconfigured' as const : 'template' as const, intervals }
}
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
export function validateDemandDay(day: DemandDay) {
  if (!day) return
  for (const interval of day) {
    const duration = minute(interval.endTime) + interval.endDayOffset * 1440 - minute(interval.startTime)
    if (duration <= 0 || duration > 1440) throw new ApiError(400, 'DEMAND_DURATION', 'Интервал должен длиться от 1 минуты до 24 часов. Для ночного и суточного интервала укажите следующий день.')
  }
}
export function validateDemandPair(day: DemandDay, next: DemandDay) {
  validateDemandDay(day); validateDemandDay(next)
  const rows = [...(day ?? []).map(row => ({ ...row, start: minute(row.startTime), end: minute(row.endTime) + row.endDayOffset * 1440 })), ...(next ?? []).map(row => ({ ...row, start: minute(row.startTime) + 1440, end: minute(row.endTime) + (row.endDayOffset + 1) * 1440 }))]
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (rows[i].positionId === rows[j].positionId && rows[i].start < rows[j].end && rows[j].start < rows[i].end) throw new ApiError(400, 'DEMAND_OVERLAP', 'Интервалы одной должности пересекаются, в том числе через полночь. Разделите их: потребность не суммируется.')
  }
}
export function validateDemandSchedule(versions: DemandVersionInput[], exceptions: DemandExceptionInput[]) {
  for (const version of versions) for (let i = 0; i < 7; i++) validateDemandPair(version.days[i], version.days[(i + 1) % 7])
  const dates = new Set([...versions.flatMap(v => [addCalendarDays(v.effectiveFrom, -1), v.effectiveFrom]), ...exceptions.flatMap(e => [addCalendarDays(e.date, -1), e.date])])
  for (const date of dates) validateDemandPair(demandForDate(date, versions, exceptions).intervals, demandForDate(addCalendarDays(date, 1), versions, exceptions).intervals)
}
// Sweep exact real boundaries; [start,end) makes touching shifts neither overlap nor leave a gap.
export function calculateCoverage(from: string, to: string, timezone: string, versions: DemandVersionInput[], exceptions: DemandExceptionInput[], shifts: CoverageShift[], positions: Array<{ id: string; name: string }>): CoverageDay[] {
  const result: CoverageDay[] = []
  for (let date = from; date < to; date = addCalendarDays(date, 1)) {
    const start = +startOfZonedDate(date, timezone), end = +startOfZonedDate(addCalendarDays(date, 1), timezone)
    const current = demandForDate(date, versions, exceptions), previousDate = addCalendarDays(date, -1), previous = demandForDate(previousDate, versions, exceptions)
    const needs = [ [date, current.intervals], [previousDate, previous.intervals] ] .flatMap(([day, intervals]) => (intervals as DemandDay ?? []).map(row => ({ positionId: row.positionId, needed: row.needed, start: +zonedDateTimeToUtc(day as string, row.startTime, timezone), end: +zonedDateTimeToUtc(addCalendarDays(day as string, row.endDayOffset), row.endTime, timezone) }))).filter(n => n.start < end && n.end > start)
    const active = shifts.filter(s => s.status === 'SCHEDULED' && s.attendance!=='NO_SHOW' && s.positionId).map(s => ({ memberId: s.memberId, positionId: s.positionId!, start: +new Date(s.actualStartAt??s.scheduledStartAt), end: +new Date(s.actualEndAt??s.scheduledEndAt) })).filter(s => s.start < end && s.end > start)
    const segments: CoverageSegment[] = []
    for (const positionId of new Set([...needs.map(n => n.positionId), ...active.map(s => s.positionId)])) {
      const roleNeeds = needs.filter(n => n.positionId === positionId), roleShifts = active.filter(s => s.positionId === positionId)
      const boundaries = [...new Set([start, end, ...roleNeeds.flatMap(n => [Math.max(start, n.start), Math.min(end, n.end)]), ...roleShifts.flatMap(s => [Math.max(start, s.start), Math.min(end, s.end)])])].sort((a,b) => a-b)
      for (let i = 0; i < boundaries.length - 1; i++) {
        const a = boundaries[i], b = boundaries[i+1], neededRows = roleNeeds.filter(n => n.start <= a && n.end > a)
        // An incoming night is configured even if today's template was never set.
        if (current.intervals === null && !neededRows.length) continue
        const needed = Math.max(0, ...neededRows.map(n => n.needed)), assigned = new Set(roleShifts.filter(s => s.start <= a && s.end > a).map(s => s.memberId)).size
        if (!needed && !assigned) continue
        const last = segments.at(-1)
        if (last && last.positionId === positionId && last.endAt === new Date(a).toISOString() && last.needed === needed && last.assigned === assigned) { last.endAt = new Date(b).toISOString(); continue }
        segments.push({ positionId, positionName: positions.find(p => p.id === positionId)?.name ?? 'Должность недоступна', startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString(), needed, assigned, shortage: Math.max(0, needed-assigned), surplus: Math.max(0, assigned-needed) })
      }
    }
    result.push({ date, source: current.source, noDemand: current.intervals?.length === 0, segments, shortageIntervals: segments.filter(s => s.shortage > 0).length, surplusIntervals: segments.filter(s => s.surplus > 0).length })
  }
  return result
}
