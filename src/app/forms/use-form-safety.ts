import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/auth-context.tsx'
import { useFormSafetyContext, type FormGuard } from './form-safety-context.ts'
import { compatibleDraft, draftKey, readDraft, removeDraft, writeDraft, type FormDraft } from './draft-storage.ts'
import { stableJson } from '../../shared/stable-json.ts'

type Options<T> = { scope: string; value: T; dirtyValue?: unknown; active?: boolean; busy?: boolean; dirty?: boolean; extraDirty?: boolean; draft?: boolean; revision?: number; onRestore?: (value: T) => void; onDiscard?: () => void; validate?: (value: unknown) => value is T }
export function useFormSafety<T>({ scope, value, dirtyValue, active = true, busy = false, dirty: explicitDirty, extraDirty = false, draft = false, revision, onRestore, onDiscard, validate }: Options<T>) {
  const { user } = useAuth()
  const { guards, notify, confirm } = useFormSafetyContext(), identity = useRef(Symbol()).current
  const key = user ? draftKey(user.id, scope) : ''
  const enabled = active && !!user
  const serialized = stableJson(dirtyValue === undefined ? value : dirtyValue)
  const cycle = useRef({ key, active: false, baseline: serialized, revision })
  const writtenHere = useRef<string | null>(null)
  if (key !== cycle.current.key || enabled && !cycle.current.active) cycle.current = { key, active: enabled, baseline: serialized, revision }
  cycle.current.active = enabled
  const dirty = enabled && (explicitDirty ?? (serialized !== cycle.current.baseline || extraDirty))
  const [candidate, setCandidate] = useState<FormDraft<T> | null>(null)
  const [saved, setSaved] = useState<string | null>(null), [storageError, setStorageError] = useState(false), [, update] = useState(0)
  const [restoredRevision, setRestoredRevision] = useState<number | undefined>()
  const initialize = useCallback((patch: Partial<T>) => {
    let baseline: unknown
    try { baseline = JSON.parse(cycle.current.baseline) } catch { baseline = {} }
    cycle.current.baseline = stableJson({ ...(baseline && typeof baseline === 'object' ? baseline : {}), ...patch })
    update(value => value + 1)
  }, [])
  const current = useRef({ value, dirty, revision, key, enabled, canWrite: false })
  current.current = { value, dirty, revision: restoredRevision ?? cycle.current.revision, key, enabled, canWrite: draft && enabled && !candidate }
  useEffect(() => {
    writtenHere.current = null
    setSaved(null); setStorageError(false); setRestoredRevision(undefined)
    if (!draft || !enabled) { setCandidate(null); return }
    const found = readDraft<T>(key)
    if (found && found.scope === scope && compatibleDraft(found.value, current.current.value) && (!validate || validate(found.value))) setCandidate(found)
    else { setCandidate(null); if (found) removeDraft(key) }
  }, [key, enabled, draft, scope, validate])
  const flush = useCallback(() => {
    const next = current.current
    if (!next.canWrite) return !next.dirty
    const ok = writeDraft(next.key, scope, next.value, next.revision)
    if (ok) writtenHere.current = next.key
    setSaved(ok ? stableJson(next.value) : null); setStorageError(!ok)
    return ok
  }, [scope])
  const guard = useRef<FormGuard>({ dirty: false, busy: false, discard: () => {} }).current
  guard.dirty = dirty; guard.busy = enabled && busy
  guard.saveDraft = draft && !candidate ? flush : undefined
  guard.discard = () => { if (key) removeDraft(key); cycle.current.baseline = serialized; guard.dirty = false; guard.busy = false; onDiscard?.(); notify() }
  useLayoutEffect(() => {
    guards.set(identity, guard)
    notify()
    return () => { guards.delete(identity); notify() }
  }, [guards, notify, identity, guard])
  useLayoutEffect(() => { notify() }, [dirty, busy, notify])
  useEffect(() => {
    if (!draft || !dirty || candidate) return
    const timer = window.setTimeout(flush, 350)
    return () => window.clearTimeout(timer)
  }, [serialized, dirty, candidate, draft, key, flush])
  useEffect(() => {
    if (!draft) return
    const save = () => { if (current.current.enabled && current.current.dirty) flush() }
    const hidden = () => { if (document.visibilityState === 'hidden') save() }
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', hidden) }
  }, [key, scope, draft, flush])
  useEffect(() => {
    if (draft && enabled && !dirty && !candidate && writtenHere.current === key) { removeDraft(key); writtenHere.current = null; setSaved(null) }
  }, [draft, enabled, dirty, candidate, key])
  return {
    initialize,
    ref: (element: HTMLElement | null) => { guard.element = element },
    dirty, candidate, saved: saved === stableJson(value), storageError,
    stale: (candidate?.revision ?? restoredRevision ?? cycle.current.revision) !== undefined && revision !== undefined && (candidate?.revision ?? restoredRevision ?? cycle.current.revision) !== revision,
    expectedRevision: restoredRevision ?? cycle.current.revision,
    restore() { if (candidate && onRestore) { writtenHere.current = key; onRestore(candidate.value); setRestoredRevision(candidate.revision); setCandidate(null); setSaved(stableJson(candidate.value)) } },
    deleteDraft() { writtenHere.current = null; removeDraft(key); setCandidate(null); setSaved(null); setStorageError(false) },
    markSaved() { writtenHere.current = null; cycle.current.baseline = serialized; guard.dirty = false; guard.busy = false; notify(); removeDraft(key); setCandidate(null); setSaved(null); update(value => value + 1) },
    confirmClose: () => confirm([guard]),
    async close(action: () => void) { if (await confirm([guard])) action() },
  }
}
