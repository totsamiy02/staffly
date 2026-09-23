import { z } from 'zod'

const personalName = z.string().trim().min(1).max(80).regex(/^[\p{L}][\p{L}\p{M}' -]*$/u, 'Используйте буквы, пробел, дефис или апостроф.')

function optionalText(schema: z.ZodString) {
  return z.union([schema, z.literal(''), z.null()]).transform((value) => value ? value : null)
}

export const russianPhone = z.union([z.string(), z.null()]).transform((value, context) => {
  if (!value?.trim()) return null
  if (!/^[+\d\s()-]+$/.test(value)) {
    context.addIssue({ code: 'custom', message: 'Укажите российский номер телефона.' })
    return z.NEVER
  }
  const digits = value.replace(/\D/g, '')
  const normalized = digits.length === 11 && (digits[0] === '7' || digits[0] === '8') ? `+7${digits.slice(1)}` : ''
  if (!/^\+7\d{10}$/.test(normalized)) {
    context.addIssue({ code: 'custom', message: 'Номер должен содержать 11 цифр и начинаться с +7 или 8.' })
    return z.NEVER
  }
  return normalized
})

export const updateProfileBody = z.object({
  firstName: optionalText(personalName),
  lastName: optionalText(personalName),
  middleName: optionalText(personalName),
  phone: russianPhone,
  bio: optionalText(z.string().trim().max(500)),
})
