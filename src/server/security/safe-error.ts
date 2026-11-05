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
