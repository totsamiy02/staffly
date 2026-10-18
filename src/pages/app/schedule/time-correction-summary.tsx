import type { ShiftDetails } from '../../../app/schedule/types.ts'
import { shiftTimeRange } from '../../../app/schedule/date-utils.ts'

export function CorrectionAuditRange({ item, timezone }: { item: ShiftDetails['adjustments'][number]; timezone: string }) {
  const snapshot = item.timeCorrection
  const before = snapshot?.before.attendance === 'NO_SHOW' ? 'Неявка · 0 ч' : `${shiftTimeRange(item.previousStartAt, item.previousEndAt, timezone)}${snapshot && !snapshot.before.actualEndAt ? ' · окончание по плану' : ''}`
  const after = snapshot?.after.attendance === 'NO_SHOW' ? 'Неявка · 0 ч' : `${shiftTimeRange(item.newStartAt, item.newEndAt, timezone)}${snapshot && !snapshot.after.actualEndAt ? ' · окончание по плану' : ''}`
  return <dl><div><dt>Было</dt><dd>{before}</dd></div><div><dt>Стало</dt><dd>{after}</dd></div></dl>
}
