export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function isTransactionConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false
  const item = error as Record<string, unknown>
  if (['P2034', '40001', '40P01'].includes(String(item.code)) || ['40001', '40P01'].includes(String(item.originalCode)) || item.kind === 'TransactionWriteConflict') return true
  return ['meta', 'cause', 'driverAdapterError', 'originalError'].some(key => isTransactionConflict(item[key], depth + 1))
}

export function isDatabaseBusy(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false
  const item = error as Record<string, unknown>
  const codes = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', '57014', '53300', '55P03', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']
  // pg-pool can reject connection acquisition without a SQLSTATE/code.
  if (item.message === 'timeout exceeded when trying to connect' || item.message === 'Connection terminated due to connection timeout') return true
  if (codes.includes(String(item.code)) || codes.includes(String(item.originalCode))) return true
  if (['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'].includes(String(item.kind))) return true
  return ['meta', 'cause', 'driverAdapterError', 'originalError'].some(key => isDatabaseBusy(item[key], depth + 1))
}
