import type { z } from 'zod'
import type { RequestDateMode,RequestSystemCode } from '../../generated/prisma/client.ts'
import type { createRequestBody,listRequestsQuery } from './schemas.ts'

import { ApiError } from '../api-error.ts'

export const absenceCodes: RequestSystemCode[] = ['VACATION', 'DAY_OFF', 'SICK_LEAVE', 'ABSENCE', 'SICK']

export const dateValue = (value: string | null | undefined) => value ? new Date(`${value}T00:00:00.000Z`) : null

export const dateText = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null

export const memberName = (user: { firstName: string | null; lastName: string | null; middleName: string | null; email: string }) => [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || user.email.split('@')[0]

export type CreateInput = z.infer<typeof createRequestBody>

export function validateTypeFields(type: { dateMode: RequestDateMode; requiresComment: boolean; systemCode: RequestSystemCode | null }, input: CreateInput) {
  if (type.requiresComment && !input.comment?.trim()) throw new ApiError(400, 'REQUEST_COMMENT_REQUIRED', 'Для этого типа заявки нужен комментарий.')
  if (type.dateMode === 'SINGLE' && !input.startDate) throw new ApiError(400, 'REQUEST_DATE_REQUIRED', 'Укажите дату заявки.')
  if (type.dateMode === 'RANGE' && (!input.startDate || !input.endDate)) throw new ApiError(400, 'REQUEST_RANGE_REQUIRED', 'Укажите начало и окончание периода.')
  if (input.startDate && input.endDate && input.startDate > input.endDate) throw new ApiError(400, 'INVALID_REQUEST_RANGE', 'Дата окончания не может быть раньше даты начала.')
  if (type.systemCode === 'SHIFT_CHANGE' && !input.relatedShiftId) throw new ApiError(400, 'SHIFT_REQUIRED', 'Выберите смену, которую нужно изменить.')
  if (!['SHIFT_CHANGE', 'DAY_OFF'].includes(type.systemCode ?? '') && input.relatedShiftId) throw new ApiError(400, 'SHIFT_NOT_ALLOWED', 'Смена доступна только для заявки на изменение смены.')
  const proposal = [input.proposedStartDate, input.proposedStartTime, input.proposedEndDate, input.proposedEndTime]
  if (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') && proposal.some((value) => !value)) throw new ApiError(400, 'SHIFT_PROPOSAL_REQUIRED', 'Укажите желаемые даты и время смены.')
  if (!['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') && proposal.some(Boolean)) throw new ApiError(400, 'SHIFT_PROPOSAL_NOT_ALLOWED', 'Новое время доступно только для изменения смены.')
}

export type ListOptions = z.infer<typeof listRequestsQuery>
