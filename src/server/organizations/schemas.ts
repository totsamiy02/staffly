import { z } from 'zod'
import { russianPhone } from '../profile/schemas.ts'
import { RUSSIAN_TIMEZONE_VALUES } from '../../app/organizations/russian-timezones.ts'

export const uuid = z.string().uuid()
export const normalizedEmail = z.string().trim().toLowerCase().email().max(254)

export const organizationIdParams = z.object({ organizationId: uuid })
export const memberParams = organizationIdParams.extend({ memberId: uuid })
export const memberListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  search: z.string().trim().max(100).optional(),
})
export const inviteParams = z.object({ inviteId: uuid })
export const createOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().transform((value) => value || null),
  timezone: z.enum(RUSSIAN_TIMEZONE_VALUES, { error: 'Выберите российский часовой пояс.' }),
})
export const updateOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.union([z.string().trim().max(1000), z.null()]).transform((value) => value || null),
  timezone: z.enum(RUSSIAN_TIMEZONE_VALUES, { error: 'Выберите российский часовой пояс.' }),
  contactEmail: z.union([normalizedEmail, z.literal(''), z.null()]).transform((value) => value || null),
  phone: russianPhone,
  website: z.union([z.string().trim().url().refine((value) => /^https?:\/\//.test(value), 'Сайт должен начинаться с http:// или https://'), z.literal(''), z.null()]).transform((value) => value || null),
  address: z.union([z.string().trim().max(300), z.literal(''), z.null()]).transform((value) => value || null),
})
export const emailInvitationBody = z.object({ email: normalizedEmail })
export const roleBody = z.object({ role: z.enum(['ADMIN', 'MEMBER']) })
export const inviteCodeBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/) })
export const ownershipRequestBody = z.object({ targetMemberId: uuid })
export const sensitiveCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) })
