import { databasePool } from '../db.ts'
import { DAY, MINUTE, MOSCOW_OFFSET, fillHistory, type HistoryPoint, type HistoryRange } from '../../shared/monitoring-history.ts'

export function historyRange(days: number, startedAt: string, daily = false): HistoryRange {
  const now = Date.now(), today = Math.floor((now + MOSCOW_OFFSET) / DAY) * DAY - MOSCOW_OFFSET
  return {
    from: new Date(days ? daily ? today - (days - 1) * DAY : now - days * DAY : Math.max(Date.parse(startedAt), now - 180 * DAY)).toISOString(),
    to: new Date(now).toISOString(), stepMs: daily || !days || days > 30 ? DAY : days > 1 ? 60 * MINUTE : 5 * MINUTE,
  }
}
export async function onlineHistory(days: number, startedAt: string) {
  const range = historyRange(days, startedAt)
  const unit = range.stepMs === DAY ? 'day' : range.stepMs === 60 * MINUTE ? 'hour' : null
  const bucket = unit ? "date_trunc($3,bucket AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'" : 'bucket'
  const { rows } = await databasePool.query(`SELECT ${bucket} AS at, round(avg(users_count))::int AS users,
    round(avg(organizations_count))::int AS organizations, round(avg(sessions_count))::int AS sessions, count(*)::int AS samples
    FROM platform_online_samples WHERE bucket >= $1::timestamptz - $2::int * interval '1 millisecond' AND bucket <= now()
    GROUP BY 1 ORDER BY 1`, unit ? [range.from, range.stepMs, unit] : [range.from, range.stepMs])
  const points: HistoryPoint[] = rows.map(row => {
    const time = +new Date(row.at), first = Math.max(time, Date.parse(range.from), Date.parse(startedAt))
    const end = Math.min(time + range.stepMs, Date.parse(range.to))
    const expected = Math.max(1, Math.floor((end - 1) / (5 * MINUTE)) - Math.ceil(first / (5 * MINUTE)) + 1)
    return { at: new Date(row.at).toISOString(), users: row.users, organizations: row.organizations, sessions: row.sessions, incomplete: row.samples < expected }
  })
  return { range, points: fillHistory(points, ['users', 'organizations', 'sessions'], range) }
}

export async function activityHistory(rows: HistoryPoint[], keys: string[], days: number, startedAt: string) {
  const range = historyRange(days, startedAt, true)
  const { rows: coverage } = await databasePool.query(`SELECT (bucket AT TIME ZONE 'Europe/Moscow')::date::text AS day,count(*)::int AS samples
    FROM platform_online_samples WHERE bucket >= $1::timestamptz AND bucket <= now() GROUP BY 1`, [range.from])
  const samples = new Map(coverage.map(row => [row.day, row.samples]))
  const now = Date.parse(range.to)
  const points = fillHistory(rows, keys, range).map(row => {
    const time = Date.parse(String(row.at ?? `${row.day}T00:00:00+03:00`)), day = new Date(time + MOSCOW_OFFSET).toISOString().slice(0, 10)
    const observed = keys.some(key => row[key] !== null && row[key] !== undefined)
    const complete = time + DAY <= now && (samples.get(day) ?? 0) === 288
    return { ...row, ...(!observed && complete ? Object.fromEntries(keys.map(key => [key, 0])) : {}), incomplete: !complete }
  })
  return { range, points }
}

type CohortCount = { cohort: string; week: number; organizations: number; total: number }
export function retentionCells(rows: CohortCount[], coverage: Map<string, number>, now = Date.now()) {
  const groups = [...new Set(rows.map(row => row.cohort))].sort().slice(-6)
  return groups.flatMap(cohort => {
    const first = Date.parse(cohort + 'T00:00:00+03:00'), total = Number(rows.find(row => row.cohort === cohort)?.total ?? 0)
    return Array.from({ length: 6 }, (_, week) => {
      const start = first + week * 7 * DAY, end = start + 7 * DAY
      const observed = Number(rows.find(row => row.cohort === cohort && Number(row.week) === week)?.organizations ?? 0)
      const elapsedCovered = Array.from({ length: 7 }, (_, day) => start + day * DAY).filter(day => day <= now).every(day => {
        const key = new Date(day + MOSCOW_OFFSET).toISOString().slice(0, 10)
        const expected = day + DAY <= now ? 288 : Math.floor((now - day) / (5 * MINUTE)) + 1
        return (coverage.get(key) ?? 0) >= expected
      })
      const ongoing = start <= now && end > now
      const state = start > now ? 'future' : !elapsedCovered ? 'unknown' : ongoing ? 'partial' : 'complete'
      return { cohort, week, total, organizations: state === 'future' || state === 'unknown' ? null : observed, observed, state, ongoing }
    })
  })
}
