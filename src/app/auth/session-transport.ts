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
