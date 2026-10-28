import { hash, verify, argon2id } from 'argon2'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { commonPasswordHashes } from './common-passwords.ts'
import { passwordRuleError } from '../../app/auth/password-rules.ts'
import { clearAuthAttempts, reserveAuthAttempt } from './attempt-limits.ts'
import { cryptoBudget } from '../security/crypto-budget.ts'

export const passwordSchema = z.string().max(256).superRefine((value, context) => {
  const message = passwordRuleError(value)
  if (message) context.addIssue({ code: 'custom', message })
  const digest = createHash('sha256').update(value.toLowerCase()).digest('hex')
  if (commonPasswordHashes.has(digest)) context.addIssue({ code: 'custom', message: 'Этот пароль слишком распространён. Придумайте другой или используйте генератор паролей.' })
})
export function passwordHash(value: string) {
  return cryptoBudget(() => hash(value, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }))
}
const dummyHashPromise = passwordHash('staffly-dummy-password-for-timing')
export async function verifyLoginPassword(storedHash: string | null, value: string, account?: string) {
  const bucket = account ? await reserveAuthAttempt('password', account, 10) : null
  const digest = storedHash ?? await dummyHashPromise
  const valid = await cryptoBudget(() => verify(digest, value))
  if (bucket && storedHash && valid) await clearAuthAttempts(bucket)
  return Boolean(storedHash) && valid
}
