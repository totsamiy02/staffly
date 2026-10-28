import { isTransactionConflict, ApiError } from '../api-error.ts'

// Retry only an entire, rolled-back, database-only session transaction. Cookies
// and JWTs are issued by the caller after the successful commit.
export async function sessionTransaction<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() }
    catch (error) {
      if (!isTransactionConflict(error)) throw error
      if (attempt >= 6) throw new ApiError(503, 'AUTH_BUSY', 'Сервис входа занят. Повторите попытку немного позже.')
      await new Promise(resolve => setTimeout(resolve, Math.min(200, 10 * 2 ** attempt) + Math.random() * 30))
    }
  }
}
