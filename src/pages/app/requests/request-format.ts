import { requestStatusNames, processLabel } from '../../../app/requests/workflow.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { RequestStatus, StaffRequest } from '../../../app/requests/types.ts'

export const statusLabels: Record<RequestStatus, string> = requestStatusNames

export const sizeLabel = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`

export const shiftWindow = (start: string, end: string, timezone: string) => {
  const startDate = zonedDateAndTime(start, timezone).date
  const endDate = zonedDateAndTime(end, timezone).date
  return `${displayDate(startDate)} · ${formatTime(start, timezone)} — ${startDate === endDate ? '' : `${displayDate(endDate)} · `}${formatTime(end, timezone)}`
}

export const requestStatusLabel = (request: StaffRequest) => request.processLabel ?? processLabel(request)

export const absenceReasonLabels = {
  SICK: 'Болезнь',
  PERSONAL: 'Личные обстоятельства',
  OTHER: 'Другое'
} as const

export const periodLabel = (request: Pick<StaffRequest, 'startDate' | 'endDate'>) => request.startDate ? request.endDate && request.endDate !== request.startDate ? `${displayDate(request.startDate)} — ${displayDate(request.endDate)}` : displayDate(request.startDate) : 'Без даты'
