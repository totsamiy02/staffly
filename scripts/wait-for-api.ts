import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export async function waitForApi({ url = 'http://127.0.0.1:3001/api/database-status', timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let databaseUnavailable = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))), redirect: 'error' })
      const body = await response.json()
      databaseUnavailable = response.status === 503 && body.connected === false
      if (response.ok && body.connected === true) return
    } catch { /* Connection refusal is expected while Prisma and tsx are starting. */ }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(intervalMs, remaining))
  }
  throw new Error(databaseUnavailable
    ? 'API запущен, но PostgreSQL недоступен. Запустите существующий сервер в Postgres.app и повторите npm run dev:all.'
    : 'API не готов на порту 3001. Проверьте ошибки dev:server выше и повторите npm run dev:all.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('[dev] Ожидаем готовности API и базы данных…')
  try {
    await waitForApi()
    console.log('[dev] API и база данных готовы. Запускаем Vite.')
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : 'Не удалось проверить готовность API.'}`)
    process.exitCode = 1
  }
}
