type Failure = Error & { status?: number; retryAfterMs?: number }
export function retryQuery(count: number, error: Failure) {
  if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) return false
  return count < ([429, 503, 504].includes(error.status ?? 0) ? 3 : 1)
}
export function queryRetryDelay(attempt: number, error: Failure) {
  return Math.min(30000, Math.max(error.retryAfterMs ?? 0, 1000 * 2 ** attempt)) + Math.random() * 500
}
