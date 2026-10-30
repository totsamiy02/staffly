import { ApiError } from '../api-error.ts'
import { wallClockToInstant, startOfCalendarDate, addCalendarDateDays, dateTimeParts } from '../../shared/date-time.ts'

export function zonedDateTimeToUtc(dateValue: string, timeValue: string, timeZone: string) {
  try { return wallClockToInstant(dateValue, timeValue, timeZone) }
  catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new ApiError(400, 'INVALID_LOCAL_TIME', 'Выбранная дата или местное время не существует в часовом поясе точки.')
  }
}

export function startOfZonedDate(dateValue: string, timeZone: string) {
  try { return startOfCalendarDate(dateValue, timeZone) }
  catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new ApiError(400, 'INVALID_LOCAL_TIME', 'Выбранная дата не существует в часовом поясе точки.')
  }
}

export const addCalendarDays = addCalendarDateDays
export const zonedParts = dateTimeParts
