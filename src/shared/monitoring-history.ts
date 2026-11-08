export type HistoryRange = { from: string; to: string; stepMs: number }
export type HistoryPoint = { [key: string]: string | number | boolean | null | undefined }
export const MINUTE = 60_000
export const DAY = 86_400_000
export const MOSCOW_OFFSET = 3 * 60 * MINUTE
export function historyTime(row: HistoryPoint) {
  return Date.parse(String(row.at ?? `${row.day}T00:00:00+03:00`))
}
export function historySegments(data: HistoryPoint[], key: string, stepMs = Infinity) {
  const segments: number[][] = []
  let segment: number[] = []
  data.forEach((row, index) => {
    const value = row[key], previous = segment.at(-1)
    const gap = previous !== undefined && historyTime(row) - historyTime(data[previous]) > stepMs * 1.5
    if (value === null || value === undefined || !Number.isFinite(Number(value)) || gap || row.incomplete || (previous !== undefined && data[previous].incomplete)) {
      if (segment.length) segments.push(segment)
      segment = []
    }
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) segment.push(index)
  })
  if (segment.length) segments.push(segment)
  return segments
}
export function historyPosition(time: number, range: Pick<HistoryRange, 'from' | 'to'>) {
  const from = Date.parse(range.from), to = Date.parse(range.to)
  return to > from ? (time - from) / (to - from) : .5
}
/** Missing buckets remain unknown; a missing observation is never a zero. */
export function fillHistory(rows: HistoryPoint[], keys: string[], range: HistoryRange) {
  const points = new Map(rows.map(row => [historyTime(row), row]))
  const origin = range.stepMs === DAY ? -MOSCOW_OFFSET : 0
  const start = Math.ceil((Date.parse(range.from) - origin) / range.stepMs) * range.stepMs + origin
  const result: HistoryPoint[] = []
  for (let time = start; time <= Date.parse(range.to); time += range.stepMs) {
    result.push(points.get(time) ?? { at: new Date(time).toISOString(), ...Object.fromEntries(keys.map(key => [key, null])) })
  }
  return result
}
