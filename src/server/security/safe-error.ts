const names = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'ApiError', 'ZodError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientInitializationError', 'PrismaClientValidationError'])
const codes = new Set(['23505', '23514', '23503', '40001', '40P01', '53300', '57014', '42P01', '42703', '42883', '42501', '3F000', '57P01', '57P02', '57P03', '08006', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAUTH', 'ECONNECTION', 'ESOCKET', 'ENOENT', 'EACCES', 'EEXIST'])
const operations = new Set(['MONITOR_SAMPLE', 'MONITOR_CLEANUP_OPERATIONS', 'MONITOR_CLEANUP_PRESENCE', 'MONITOR_CLEANUP_ONLINE', 'MONITOR_CLEANUP_ACTIVITY', 'MONITOR_CLEANUP_FEATURES'])
const poolFailures: Record<string, string> = {
  'timeout exceeded when trying to connect': 'POOL_ACQUIRE_TIMEOUT',
  'Connection terminated due to connection timeout': 'POOL_CONNECT_TIMEOUT',
  'Cannot use a pool after calling end on the pool': 'POOL_CLOSED',
}
// Provider/Prisma messages can contain SQL values, email bodies or credentials.
// Keep only known classes and diagnostic codes, never messages, causes or stacks.
type SafeDiagnostic = { name: string; code?: string; operation?: string }
export function safeError(error: unknown, depth = 0): SafeDiagnostic {
  if (!error || typeof error !== 'object') return { name: 'UnknownError' }
  const name = 'name' in error && typeof error.name === 'string' && names.has(error.name) ? error.name : 'Error'
  const value = 'code' in error && typeof error.code === 'string' ? error.code : ''
  let code = codes.has(value) || /^P\d{4}$/.test(value) ? value : undefined
  if (!code && 'message' in error && typeof error.message === 'string' && Object.hasOwn(poolFailures, error.message)) code = poolFailures[error.message]
  // Wrapping a query adds its fixed operation, never a provider message. Inspect
  // only allowlisted diagnostics in bounded nested causes / AggregateError.
  if (!code && depth < 3) {
    const children = ['cause' in error ? error.cause : undefined, ...('errors' in error && Array.isArray(error.errors) ? error.errors.slice(0, 4) : [])]
    for (const child of children) { code = safeError(child, depth + 1).code; if (code) break }
  }
  const operation = 'operation' in error && typeof error.operation === 'string' && operations.has(error.operation) ? error.operation : undefined
  return { name, ...(code ? { code } : {}), ...(operation ? { operation } : {}) }
}

export function safeApiError(error: unknown, request: { method: string; route?: { path?: unknown } }, errorId: string) {
  // A declared route template has no query values, emails or filenames.
  const route = typeof request.route?.path === 'string' ? request.route.path.slice(0, 200) : 'unmatched'
  return { errorId, at: new Date().toISOString(), method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER', route, ...safeError(error) }
}
