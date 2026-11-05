import { readTabValue, writeTabValue, removeTabValue, tabKeys } from '../workspace/tab-storage.ts'
const prefix = 'staffly:form-draft:'
const ttl = 24 * 60 * 60 * 1000
const maxBytes = 256 * 1024
export type FormDraft<T> = { schema: 1; scope: string; savedAt: number; revision?: number; value: T }
export function draftKey(userId: string, scope: string) { return prefix + userId + ':' + scope }
export function readDraft<T>(key: string): FormDraft<T> | null {
  try {
    const raw = readTabValue(key)
    if (!raw) return null
    if (raw.length > maxBytes) { removeTabValue(key); return null }
    const draft = JSON.parse(raw) as FormDraft<T>
    if (draft.schema !== 1 || typeof draft.scope !== 'string' || !Number.isFinite(draft.savedAt) || draft.savedAt > Date.now() + 60000 || Date.now() - draft.savedAt > ttl || !draft.value || typeof draft.value !== 'object') {
      removeTabValue(key); return null
    }
    return draft
  } catch { return null }
}
export function writeDraft<T>(key: string, scope: string, value: T, revision?: number): boolean {
  try {
    const raw = JSON.stringify({ schema: 1, scope, savedAt: Date.now(), revision, value })
    if (raw.length > maxBytes) return false
    return writeTabValue(key, raw)
  } catch { return false }
}
export function removeDraft(key: string) { try { removeTabValue(key) } catch { /* Storage may be disabled. */ } }
export function compatibleDraft(value: unknown, template: unknown, depth = 0): boolean {
  if (depth > 24) return false
  if (template === null || template === undefined) return value === null || ['string', 'number', 'boolean'].includes(typeof value)
  if (Array.isArray(template)) return Array.isArray(value) && value.every(item => item !== null && (template.length ? compatibleDraft(item, template[0], depth + 1) : ['string', 'number', 'boolean', 'object'].includes(typeof item)))
  if (typeof template === 'object') return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(template).every(([key, child]) => compatibleDraft((value as Record<string, unknown>)[key], child, depth + 1))
  return typeof value === typeof template
}
export function clearFormDrafts(exceptUserId?: string) {
  try { for (const key of tabKeys()) if ([prefix, 'staffly:module-filters:', 'staffly:module-route:', 'staffly:report-job:'].some(value => key.startsWith(value) && (!exceptUserId || !key.startsWith(value + exceptUserId + ':')))) removeTabValue(key) } catch { /* Storage may be disabled. */ }
}
