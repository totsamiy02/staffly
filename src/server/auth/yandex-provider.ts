import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from '../api-error.ts'

export type YandexConfig = { clientId: string; clientSecret: string; redirectUri: string; origin: string }
export type YandexProfile = { subject: string; email: string | null; firstName: string | null; lastName: string | null; avatarId: string | null }
const callbackPath = '/api/auth/yandex/callback'

export function yandexConfig(): YandexConfig | null {
  const clientId = process.env.YANDEX_CLIENT_ID?.trim()
  const clientSecret = process.env.YANDEX_CLIENT_SECRET?.trim()
  const redirectUri = process.env.YANDEX_REDIRECT_URI?.trim()
  const origin = process.env.APP_ORIGIN?.trim()
  if (!clientId || !clientSecret || !redirectUri || !origin) return null
  try {
    const app = new URL(origin), callback = new URL(redirectUri)
    if (app.origin !== origin || callback.origin !== origin || callback.pathname !== callbackPath || callback.search || callback.hash || callback.username || callback.password) return null
    if (app.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && app.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname))) return null
    return { clientId, clientSecret, redirectUri, origin }
  } catch { return null }
}

export function yandexAuthorizationUrl(config: YandexConfig, state: string, verifier: string) {
  const url = new URL('https://oauth.yandex.ru/authorize')
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'login:email login:info', optional_scope: 'login:avatar', force_confirm: 'yes' }).toString()
  return url.href
}

export async function boundedBody(response: Response, limit: number) {
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit || !response.body) throw new Error('Provider response rejected')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > limit) throw new Error('Provider response too large')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined) }
}

function personalName(input: unknown) {
  if (typeof input !== 'string') return null
  const value = input.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 80)
  return /^[\p{L}][\p{L}\p{M}' -]*$/u.test(value) ? value : null
}

export function parseYandexProfile(input: unknown, clientId: string): YandexProfile {
  const data = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), client_id: z.string().optional(), default_email: z.string().optional(), first_name: z.unknown().optional(), last_name: z.unknown().optional(), default_avatar_id: z.string().max(200).optional(), is_avatar_empty: z.boolean().optional() }).parse(input)
  if (data.client_id && data.client_id !== clientId) throw new Error('Provider client mismatch')
  const email = z.string().trim().toLowerCase().email().max(254).safeParse(data.default_email)
  return { subject: data.id, email: email.success ? email.data : null, firstName: personalName(data.first_name), lastName: personalName(data.last_name), avatarId: !data.is_avatar_empty && data.default_avatar_id && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(data.default_avatar_id) ? data.default_avatar_id : null }
}

export async function exchangeYandexCode(config: YandexConfig, code: string, verifier: string, fetcher: typeof fetch = fetch): Promise<YandexProfile> {
  try {
    const tokenResponse = await fetcher('https://oauth.yandex.ru/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier }) })
    const token = z.object({ access_token: z.string().min(1).max(4096) }).parse(JSON.parse((await boundedBody(tokenResponse, 32_768)).toString('utf8')))
    const userResponse = await fetcher('https://login.yandex.ru/info?format=json', { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `OAuth ${token.access_token}` } })
    return parseYandexProfile(JSON.parse((await boundedBody(userResponse, 65_536)).toString('utf8')), config.clientId)
  } catch {
    // Never propagate HTTP bodies, token exchange parameters, or provider errors to logs/UI.
    throw new ApiError(502, 'YANDEX_UNAVAILABLE', 'Не удалось подтвердить вход у Яндекса. Попробуйте ещё раз.')
  }
}

export async function yandexAvatar(avatarId: string, fetcher: typeof fetch = fetch) {
  if (avatarId.length > 200 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(avatarId)) throw new Error('Invalid avatar identifier')
  const url = `https://avatars.yandex.net/get-yapic/${avatarId.split('/').map(encodeURIComponent).join('/')}/islands-200`
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
  return boundedBody(response, 2 * 1024 * 1024)
}
