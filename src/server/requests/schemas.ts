import { z } from 'zod'

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Укажите дату в формате ГГГГ-ММ-ДД.').refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}, 'Укажите существующую календарную дату.')
const timeOnly = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Укажите время в формате ЧЧ:ММ.')

export const organizationRequestParams = z.object({ organizationId: z.string().uuid() })
export const requestParams = organizationRequestParams.extend({ requestId: z.string().uuid() })
export const requestTypeParams = organizationRequestParams.extend({ typeId: z.string().uuid() })
export const attachmentParams = requestParams.extend({ attachmentId: z.string().uuid() })
export const listRequestsQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  typeId: z.string().uuid().optional(),
  memberId: z.string().uuid().optional(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  search: z.string().trim().max(100).optional(),
})
export const createRequestBody = z.object({ requestTypeId: z.string().uuid(), startDate: dateOnly.nullish(), endDate: dateOnly.nullish(), comment: z.string().trim().max(2000).nullish(), relatedShiftId: z.string().uuid().nullish(), proposedStartDate: dateOnly.nullish(), proposedStartTime: timeOnly.nullish(), proposedEndDate: dateOnly.nullish(), proposedEndTime: timeOnly.nullish() })
export const resolveRequestBody = z.object({ comment: z.string().trim().max(1000).nullish(), cancelConflictingShifts: z.boolean().default(false) })
export const rejectRequestBody = z.object({ comment: z.string().trim().min(3, 'Укажите причину отклонения.').max(1000) })
export const createRequestTypeBody = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(500).nullish(), dateMode: z.enum(['NONE', 'SINGLE', 'RANGE']), requiresComment: z.boolean(), allowsAttachments: z.boolean() })
export const updateRequestTypeBody = createRequestTypeBody.extend({ isActive: z.boolean() })
