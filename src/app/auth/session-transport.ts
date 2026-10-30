export async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let parsed: unknown = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as T & { message?: string; code?: string; errors?: unknown }
  if (!response.ok) {
    const fallback = response.status === 404 ? 'Запрошенные данные не найдены.' : response.status >= 500 ? 'Сервис временно недоступен. Попробуйте позже.' : 'Не удалось выполнить запрос.'
    const error = new Error(data.message || fallback) as Error & { code?: string; status?: number; errors?: unknown; retryAfterMs?: number }
    error.code = data.code
    error.status = response.status
    error.errors = data.errors
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) error.retryAfterMs = Math.min(30000, Math.max(0, Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())) || undefined
    throw error
  }
  return data
}

export async function postAuthJson(path: string, body: unknown): Promise<Response> {
  const execute = () => fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(body),
  })
  // Refresh cookies are shared by tabs. Serialize rotation and account changes by origin.
  if (['refresh', 'login', 'verify-email', 'yandex/complete', 'logout', 'reset-password'].includes(path) && navigator.locks) return navigator.locks.request('staffly-auth-cookie', { signal: AbortSignal.timeout(12000) }, execute)
  return execute()
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
  const response = await postAuthJson('refresh', {})
  return [401, 403].includes(response.status) ? null : readJson<T>(response)
}
