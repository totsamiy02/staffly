import { hash, verify, argon2id } from 'argon2'
import { z } from 'zod'

export const passwordSchema = z.string().min(10).max(128)
  .refine(value => /[a-zа-яё]/u.test(value), 'Добавьте строчную букву.')
  .refine(value => /[A-ZА-ЯЁ]/u.test(value), 'Добавьте заглавную букву.')
  .refine(value => /\d/.test(value), 'Добавьте цифру.')
  .refine(value => /[^\p{L}\p{N}\s]/u.test(value), 'Добавьте специальный символ.')
  .refine(value => !/\s/u.test(value), 'Пароль не должен содержать пробелов.')
export function passwordHash(value: string) {
  return hash(value, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
}
const dummyHashPromise = passwordHash('staffly-dummy-password-for-timing')
export async function verifyLoginPassword(storedHash: string | null, value: string) {
  const valid = await verify(storedHash ?? await dummyHashPromise, value)
  return Boolean(storedHash) && valid
}
