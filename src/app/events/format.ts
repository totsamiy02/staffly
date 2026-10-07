import { formatTime, shiftTimeRange, zonedDateAndTime } from '../schedule/date-utils.ts'
import { RUSSIAN_TIMEZONES } from '../organizations/russian-timezones.ts'
import type { StaffEvent } from './types.ts'
export function eventTimezoneLabel(timezone: string) { return RUSSIAN_TIMEZONES.find(zone => zone.value === timezone)?.label ?? timezone }
export function eventDate(event: Pick<StaffEvent, 'startAt' | 'timezone'>) { return zonedDateAndTime(event.startAt, event.timezone).date }
export function eventTime(event: Pick<StaffEvent, 'startAt' | 'endAt' | 'timezone'>) { return event.endAt ? shiftTimeRange(event.startAt, event.endAt, event.timezone) : formatTime(event.startAt, event.timezone) }
