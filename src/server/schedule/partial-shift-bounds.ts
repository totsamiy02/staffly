import type { WorkShift } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'

export function assertPartialShiftBounds(
  shift: WorkShift,
  start: Date | null,
  end: Date | null,
  attendance?: string,
  memberId = shift.memberId,
) {
  if (shift.replacementCutoffAt && (memberId !== shift.memberId || attendance === 'NO_SHOW' || end && end > shift.replacementCutoffAt)) {
    throw new ApiError(409, 'PARTIAL_SHIFT_BOUNDARY', 'Первая часть уже завершена для замены. Время не должно выходить за сохранённую границу.')
  }
  if (shift.replacementFloorAt && start && start < shift.replacementFloorAt) {
    throw new ApiError(409, 'PARTIAL_SHIFT_BOUNDARY', 'Замена не может начинаться раньше завершения работы первого сотрудника.')
  }
}
