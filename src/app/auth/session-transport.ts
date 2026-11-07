import { reportClientFailure } from '../support/client-diagnostics.ts'
import { guardRequest, invalidResponseError, supportIdPattern, type RequestFailure } from './request-errors.ts'
export { connectionError } from './request-errors.ts'

const serviceMessages: Record<string, string> = {
  DATABASE_BUSY: 'Сервис занят. Повторите попытку немного позже.',
  AUTH_BUSY: 'Сервис входа занят. Повторите попытку немного позже.',
  PREVIEW_BUSY: 'Сервис просмотра занят. Повторите попытку немного позже.',
  FILE_VALIDATION_BUSY: 'Сервис обработки файлов занят. Повторите попытку позже.',
  FILE_PROCESSOR_UNAVAILABLE: 'Обработка файлов временно недоступна.',
  EXPORT_BUSY: 'Очередь отчётов занята. Повторите попытку немного позже.',
  SECURITY_EMAIL_UNAVAILABLE: 'Письмо не отправлено. Повторите запрос позже.',
  EMAIL_SEND_FAILED: 'Не удалось отправить код. Попробуйте начать изменение почты заново.',
  YANDEX_UNAVAILABLE: 'Не удалось подтвердить вход у Яндекса. Попробуйте ещё раз.',
  YANDEX_DISABLED: 'Вход через Яндекс пока недоступен.',
}

export async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { /* Gateway HTML and truncated JSON are not successful API results. */ }
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as T & { message?: string; code?: string; errors?: unknown; errorId?: string }
  if (!response.ok) {
    const fallback = response.status === 401 ? 'Сессия завершена. Войдите в аккаунт снова.' : response.status === 403 ? 'Недостаточно прав для этого действия.' : response.status === 404 ? 'Запрошенные данные не найдены.' : response.status === 429 ? 'Слишком много запросов. Подождите немного и повторите попытку.' : response.status >= 500 ? 'Сервис временно недоступен. Попробуйте немного позже.' : 'Не удалось выполнить запрос.'
    const reference=data.errorId??response.headers.get('x-support-code')
    const errorId = typeof reference === 'string' && supportIdPattern.test(reference) ? reference : reportClientFailure('INVALID_RESPONSE')
    const code = typeof data.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.code) ? data.code : undefined
    // Only known service messages may replace the generic 5xx message. Never show
    // an upstream exception, SQL, stack trace, or proxy response to the user.
    const message = response.status >= 500 ? (code && Object.hasOwn(serviceMessages, code) ? serviceMessages[code] : fallback) : typeof data.message === 'string' && data.message.trim() && data.message.length <= 1000 && !/[<>]/.test(data.message) && !Array.from(data.message).some(char => char.charCodeAt(0) < 32) ? data.message : fallback
    const error: RequestFailure = new Error(message + (errorId ? ' Код для поддержки: ' + errorId : ''))
    error.errorId = errorId
    error.code = code
    error.status = response.status
    error.errors = data.errors
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) error.retryAfterMs = Math.min(30000, Math.max(0, Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())) || undefined
    if (typeof window !== 'undefined' && ['SUBSCRIPTION_FEATURE_REQUIRED', 'SUBSCRIPTION_LIMIT_REACHED', 'SUBSCRIPTION_EXPIRED', 'ORGANIZATION_STORAGE_QUOTA'].includes(data.code ?? '')) {
      const organizationId = /\/organizations\/([0-9a-f-]{36})/.exec(response.url)?.[1]
      if (organizationId) window.dispatchEvent(new CustomEvent('staffly:subscription-required', { detail: { organizationId, ...(data.errors && typeof data.errors === 'object' ? data.errors : {}), ...(data.code === 'ORGANIZATION_STORAGE_QUOTA' ? { kind: 'storage' } : {}), message: error.message } }))
    }
    throw error
  }
  if (parsed === null || typeof parsed !== 'object') throw invalidResponseError(response.status)
  return parsed as T
}

export function authPost<T>(path: string, body: unknown): Promise<T> {
  return guardRequest(async () => readJson<T>(await postAuthJson(path, body)), { mutation: true })
}

export function authGet<T>(path: string): Promise<T> {
  return guardRequest(async () => readJson<T>(await fetch(`/api/auth/${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) })))
}

export async function postAuthJson(path: string, body: unknown): Promise<Response> {
  const send = () => fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(body),
  })
  const execute = async () => {
    try { return await send() }
    catch (error) {
      // A response may be lost after the server committed rotation. Keep the
      // origin lock during this one retry; the server coalesces spent tokens.
      if (path !== 'refresh' || !(error instanceof TypeError || error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))) throw error
      return send()
    }
  }
  // Refresh cookies are shared by tabs. Serialize rotation and account changes by origin.
  return guardRequest(() => {
    if (['refresh', 'login', 'verify-email', 'yandex/complete', 'logout', 'reset-password'].includes(path) && navigator.locks) return navigator.locks.request('staffly-auth-cookie', { signal: AbortSignal.timeout(25000) }, execute)
    return execute()
  }, { mutation: path !== 'refresh' })
}

// JWT claims are used only to schedule refresh; the server still verifies every token.
export function accessTokenNeedsRefresh(token: string | null, now = Date.now()) {
  if (!token) return false
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(part)) as { exp?: number }
    // Stable per-token jitter spreads an office's refreshes over two minutes.
    // This only schedules refresh earlier; the server's JWT expiry is unchanged.
    let hash = 2166136261
    for (const char of token.slice(-32)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
    return typeof exp === 'number' && exp * 1000 <= now + 30_000 + hash % 120_001
  } catch { return false }
}

export async function requestWithSession(
  execute: (token: string | null) => Promise<Response>,
  getToken: () => string | null,
  refresh: () => Promise<{ accessToken: string } | null>,
) {
  let token = getToken()
  if (accessTokenNeedsRefresh(token)) {
    const result = await refresh()
    if (!result) throw new Error('Сессия завершена. Войдите в аккаунт снова.')
    token = getToken() ?? result.accessToken
  }
  const response = await execute(token)
  if (response.status !== 401) return response
  // Another request may already have refreshed while this response was in flight.
  const current = getToken()
  if (current && current !== token) return execute(current)
  const result = await refresh()
  return result ? execute(getToken() ?? result.accessToken) : response
}

// Only an explicit authentication rejection ends a session. Temporary HTTP and
// transport failures propagate to query retry without clearing the current user.
export async function refreshSession<T>(): Promise<T | null> {
  return guardRequest(async () => {
    const response = await postAuthJson('refresh', {})
    return [401, 403].includes(response.status) ? null : readJson<T>(response)
  })
}
