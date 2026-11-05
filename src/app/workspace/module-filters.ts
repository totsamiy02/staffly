import { readTabValue, writeTabValue } from './tab-storage.ts'
import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context.tsx'
import { isCalendarDate } from '../../shared/date-time.ts'
type Value = string | number | boolean
type Filters = Record<string, Value>
const prefix = 'staffly:module-filters:'
export function useModuleFilters<T extends Filters>(module: string, organizationId: string, defaults: T, validators: Partial<Record<keyof T, (value: Value) => boolean>> = {}) {
  const { user } = useAuth(), [params, setParams] = useSearchParams()
  const key = prefix + user?.id + ':' + organizationId + ':' + module
  const cache = useRef<{ key: string; values: Record<string, string> }>({ key: '', values: {} })
  if (cache.current.key !== key) {
    let values: Record<string, string> = {}
    try { const stored = JSON.parse(readTabValue(key) ?? 'null'); if (stored && Date.now() - stored.at < 86400000 && stored.values && typeof stored.values === 'object' && !Array.isArray(stored.values)) values = stored.values } catch { /* Use defaults when storage is unavailable. */ }
    cache.current = { key, values }
  }
  const keys = Object.keys(defaults), explicit = keys.some(name => params.has(name))
  const pending = useRef<URLSearchParams | null>(null)
  const replacePending = useRef(true)
  const values = Object.fromEntries(keys.map(name => {
    const fallback = defaults[name], raw = params.get(name) ?? (!explicit ? cache.current.values[name] : undefined)
    let value = typeof fallback === 'number' ? raw && /^\d{1,6}$/.test(raw) ? Math.max(1, Number(raw)) : fallback : typeof fallback === 'boolean' ? raw === undefined || raw === null ? fallback : raw === 'true' : typeof raw === 'string' && raw.length <= 300 ? raw : fallback
    if (typeof value === 'string' && value && (name === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || ['day', 'from', 'to'].includes(name) && !isCalendarDate(value))) value = fallback
    if (validators[name] && !validators[name]!(value)) value = fallback
    return [name, value]
  })) as T
  const serialized = JSON.stringify(values), query = params.toString()
  useEffect(() => {
    if (new URLSearchParams(window.location.search).toString() !== query) return
    const snapshot = JSON.parse(serialized) as T
    const stored = Object.fromEntries(Object.entries(snapshot).map(([name, value]) => [name, String(value)]))
    cache.current.values = stored
    try { writeTabValue(key, JSON.stringify({ at: Date.now(), values: stored })) } catch { /* URL remains the source of truth. */ }
    if (!explicit || Object.entries(snapshot).some(([name, value]) => new URLSearchParams(query).get(name) !== String(value))) {
      const next = new URLSearchParams(query)
      for (const [name, value] of Object.entries(snapshot)) next.set(name, String(value))
      setParams(next, { replace: true })
    }
  }, [key, serialized, explicit, query, setParams])
  function schedule(replace = true) {
    replacePending.current = pending.current ? replacePending.current && replace : replace
    if (!pending.current) {
      // The router may have updated history before React committed the next
      // render. Read the current URL so a fast second edit cannot undo the first.
      pending.current = new URLSearchParams(window.location.search)
      // Seed all values: a new URL must not silently reset remembered sibling filters.
      for (const k of keys) if (!pending.current.has(k)) pending.current.set(k, String(values[k]))
      queueMicrotask(() => {
        const next = pending.current; pending.current = null
        if (next) setParams(next, { replace: replacePending.current })
      })
    }
    return pending.current
  }
  function change<K extends keyof T>(name: K, value: T[K] | ((previous: T[K]) => T[K])) {
    const nextParams = schedule()
    const previous = nextParams.get(String(name))
    const typed = typeof defaults[name] === 'number' ? Number(previous) : typeof defaults[name] === 'boolean' ? previous === 'true' : previous
    const next = typeof value === 'function' ? value(typed as T[K]) : value
    nextParams.set(String(name), String(next))
  }
  const changeRef = useRef(change)
  changeRef.current = change
  const setters = useRef(new Map<keyof T, unknown>()).current
  return {
    field<K extends keyof T>(name: K): [T[K], (value: T[K] | ((previous: T[K]) => T[K])) => void] {
      type Setter = (value: T[K] | ((previous: T[K]) => T[K])) => void
      if (!setters.has(name)) setters.set(name, (value: T[K] | ((previous: T[K]) => T[K])) => changeRef.current(name, value))
      return [values[name], setters.get(name) as Setter]
    },
    patch(update: (params: URLSearchParams) => URLSearchParams, options: { replace?: boolean } = {}) { const next = update(new URLSearchParams(schedule(options.replace ?? false))); pending.current = next },
  }
}
