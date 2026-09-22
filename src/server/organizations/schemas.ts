import { z } from 'zod'

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
export const emailInvitationBody = z.object({ email: normalizedEmail })
export const roleBody = z.object({ role: z.enum(['ADMIN', 'MEMBER']) })
export const inviteCodeBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/) })
export const ownershipRequestBody = z.object({ targetMemberId: uuid })
export const sensitiveCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) })
