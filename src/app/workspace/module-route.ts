import { readTabValue, writeTabValue } from './tab-storage.ts'
const fields = new Set(['tab', 'section', 'view', 'pointId', 'dashboardPoint', 'month', 'day', 'from', 'to', 'page', 'search', 'sort', 'status', 'member', 'memberId', 'typeId', 'role', 'folder', 'system'])
const key = (userId: string, org: string, module: string) => 'staffly:module-route:' + userId + ':' + org + ':' + module
export function rememberModuleRoute(userId: string, org: string, module: string, query: string) {
  const params = new URLSearchParams(query), saved = new URLSearchParams()
  for (const [name, value] of params) if (fields.has(name) && value.length <= 300) saved.set(name, value)
  try { writeTabValue(key(userId, org, module), JSON.stringify({ at: Date.now(), query: saved.toString() })) } catch { /* Navigation still works without storage. */ }
}
export function moduleRoute(userId: string, org: string, module: string, locationId?: string) {
  let params = new URLSearchParams()
  try {
    const stored = JSON.parse(readTabValue(key(userId, org, module)) ?? 'null')
    if (stored && Date.now() - stored.at < 86400000 && typeof stored.query === 'string') {
      for (const [name, value] of new URLSearchParams(stored.query)) if (fields.has(name) && value.length <= 300) params.set(name, value)
    }
  } catch { /* Use the module defaults. */ }
  if (locationId) params.set('location', locationId)
  return '/app/organizations/' + org + (module ? '/' + module : '') + '?' + params
}
