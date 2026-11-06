const names = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'ApiError', 'ZodError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientInitializationError', 'PrismaClientValidationError'])
const codes = new Set(['23505', '23514', '23503', '40001', '40P01', '53300', '57014', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAUTH', 'ECONNECTION', 'ESOCKET', 'ENOENT', 'EACCES', 'EEXIST'])
// Provider/Prisma messages can contain SQL values, email bodies or credentials.
// Keep only known classes and diagnostic codes, never messages, causes or stacks.
export function safeError(error: unknown) {
  if (!error || typeof error !== 'object') return { name: 'UnknownError' }
  const name = 'name' in error && typeof error.name === 'string' && names.has(error.name) ? error.name : 'Error'
  const value = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return { name, ...(codes.has(value) || /^P\d{4}$/.test(value) ? { code: value } : {}) }
}

export function safeApiError(error: unknown, request: { method: string; route?: { path?: unknown } }, errorId: string) {
  // A declared route template has no query values, emails or filenames.
  const route = typeof request.route?.path === 'string' ? request.route.path.slice(0, 200) : 'unmatched'
  return { errorId, at: new Date().toISOString(), method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER', route, ...safeError(error) }
}
