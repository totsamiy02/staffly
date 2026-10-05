export async function postAuthJson(path: string, body: unknown): Promise<Response> {
  const execute = () => fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  // Refresh cookies are shared by tabs. Serialize rotation and account changes by origin.
  if (['refresh', 'login', 'verify-email', 'logout', 'reset-password'].includes(path) && navigator.locks) return navigator.locks.request('staffly-auth-cookie', execute)
  return execute()
}

// JWT claims are used only to schedule refresh; the server still verifies every token.
export function accessTokenNeedsRefresh(token: string | null, now = Date.now()) {
  if (!token) return false
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(part)) as { exp?: number }
    return typeof exp === 'number' && exp * 1000 <= now + 30_000
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
