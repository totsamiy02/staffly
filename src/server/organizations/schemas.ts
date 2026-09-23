import { z } from 'zod'
import { russianPhone } from '../profile/schemas.ts'

export const uuid = z.string().uuid()
export const normalizedEmail = z.string().trim().toLowerCase().email().max(254)

function isTimeZone(value: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true } catch { return false }
}

export const organizationIdParams = z.object({ organizationId: uuid })
export const memberParams = organizationIdParams.extend({ memberId: uuid })
export const inviteParams = z.object({ inviteId: uuid })
export const createOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().transform((value) => value || null),
  timezone: z.string().trim().max(64).refine(isTimeZone, 'Некорректный часовой пояс.'),
})
export const updateOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.union([z.string().trim().max(1000), z.null()]).transform((value) => value || null),
  timezone: z.string().trim().max(64).refine(isTimeZone, 'Некорректный часовой пояс.'),
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
