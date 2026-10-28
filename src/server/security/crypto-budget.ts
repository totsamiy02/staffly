import { ApiError } from '../api-error.ts'
import { positiveInteger } from '../runtime.ts'

const maximum = positiveInteger('AUTH_CRYPTO_CONCURRENCY', 2, 32)
const waiting: Array<{ start: () => void }> = []
let active = 0
export async function cryptoBudget<T>(work: () => Promise<T>): Promise<T> {
  if (active >= maximum) {
    if (waiting.length >= 32) throw new ApiError(503, 'AUTH_BUSY', 'Сервис входа занят. Повторите попытку немного позже.')
    await new Promise<void>((resolve, reject) => {
      const entry = { start: () => { clearTimeout(timer); resolve() } }
      const timer = setTimeout(() => {
        const index = waiting.indexOf(entry)
        if (index >= 0) waiting.splice(index, 1)
        reject(new ApiError(503, 'AUTH_BUSY', 'Сервис входа занят. Повторите попытку немного позже.'))
      }, 5000)
      waiting.push(entry)
    })
  } else active++
  try { return await work() }
  finally { const next = waiting.shift(); if (next) next.start(); else active-- }
}
