import { diagnosticsDocumentDeparting,reportClientFailure } from '../support/client-diagnostics.ts'
export type RequestFailure = Error & { code?: string; status?: number; errors?: unknown; retryAfterMs?: number; errorId?: string }
export const supportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function invalidResponseError(status = 502) {
  return Object.assign(new Error('Не удалось получить корректный ответ сервера. Повторите попытку. Если вы сохраняли изменения, сначала проверьте результат операции.'), { code: 'INVALID_RESPONSE', status })
}

export function connectionError(error: unknown, mutation = false): RequestFailure {
  if (error instanceof TypeError || error instanceof DOMException && ['TimeoutError', 'AbortError', 'NetworkError'].includes(error.name)) {
    const timeout = error.name === 'TimeoutError'
    const message = mutation
      ? 'Не удалось получить подтверждение от сервера. Проверьте соединение и результат операции перед повторной отправкой.'
      : timeout ? 'Сервер не ответил вовремя. Повторите попытку немного позже.' : 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    return Object.assign(new Error(message), { code: timeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', status: 0 })
  }
  return error instanceof Error ? error : new Error('Не удалось выполнить запрос.')
}

/** Covers reading the body too: fetch may succeed before the connection breaks. */
export async function guardRequest<T>(work: () => Promise<T>, { mutation = false, signal }: { mutation?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  try { return await work() }
  catch (error) {
    // Closing a preview or cancelling a query is not a network failure.
    if (signal?.aborted||diagnosticsDocumentDeparting()) throw error
    const failure=connectionError(error, mutation)
    if(!failure.errorId&&['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE'].includes(failure.code??'')){const id=reportClientFailure(failure.code as 'NETWORK_ERROR'|'REQUEST_TIMEOUT'|'INVALID_RESPONSE');if(id){failure.errorId=id;failure.message+=' Код для поддержки: '+id}}
    if(typeof window!=='undefined'&&failure.errorId&&!['ADMIN_LOCKED','ADMIN_AUTH_REQUIRED','ADMIN_FORBIDDEN'].includes(failure.code??''))window.dispatchEvent(new CustomEvent('staffly:request-failed',{detail:failure}))
    throw failure
  }
}

export function requestSignal(signal?: AbortSignal, timeoutMs = 15000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Existing callers store error.message in state/toasts; keep their reference usable. */
export function requestErrorDetails(error: unknown): { message: string; errorId?: string } {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Не удалось выполнить запрос.'
  const suffix = /\s+Код для поддержки: ([0-9a-f-]+)$/i.exec(message)
  const reference = error && typeof error === 'object' && 'errorId' in error ? error.errorId : suffix?.[1]
  const errorId = typeof reference === 'string' && supportIdPattern.test(reference) ? reference : undefined
  return { message: errorId && suffix ? message.slice(0, suffix.index) : message, errorId }
}
