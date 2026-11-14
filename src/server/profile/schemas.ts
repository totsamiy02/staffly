import { z } from 'zod'

const personalName = z.string().trim().min(1).max(80).regex(/^[\p{L}][\p{L}\p{M}' -]*$/u, 'Используйте буквы, пробел, дефис или апостроф.')

function optionalText(schema: z.ZodString) {
  return z.union([schema, z.literal(''), z.null()]).transform((value) => value ? value : null)
}

export {russianPhone} from '../../shared/profile-validation.ts'
import {russianPhone} from '../../shared/profile-validation.ts'

export const updateProfileBody = z.object({
  avatarUploadId: z.uuid().nullable().optional(),
  firstName: optionalText(personalName),
  lastName: optionalText(personalName),
  middleName: optionalText(personalName),
  phone: russianPhone,
  bio: optionalText(z.string().trim().max(500)),
})
