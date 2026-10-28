import { AsyncLocalStorage } from 'node:async_hooks'
// One HTTP GET only. Transactional writes never reuse this authorization snapshot.
export const requestReads = new AsyncLocalStorage<Map<string, Promise<unknown>>>()
