import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { readDraft, writeDraft, draftKey, clearFormDrafts, compatibleDraft } from '../../src/app/forms/draft-storage.ts'
import { moduleRoute, rememberModuleRoute } from '../../src/app/workspace/module-route.ts'
import { readJson, connectionError } from '../../src/app/auth/session-transport.ts'
const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const memory: Record<string, string> = {}
const storage = new Proxy(memory, { get(target, key) {
  if (key === 'getItem') return (name: string) => target[name] ?? null
  if (key === 'setItem') return (name: string, value: string) => { target[name] = String(value) }
  if (key === 'removeItem') return (name: string) => { delete target[name] }
  return Reflect.get(target, key)
} })
before(() => Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage }))
after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage') })
it('keeps drafts scoped, expires old records, tolerates unavailable storage and validates restored structure', () => {
  const first = draftKey('user-a', 'event:org-a:point-a'), second = draftKey('user-b', 'event:org-a:point-a')
  assert.equal(writeDraft(first, 'event:org-a:point-a', { text: 'Retained text' }, 3), true)
  assert.equal(readDraft<{ text: string }>(first)?.value.text, 'Retained text')
  assert.equal(readDraft(second), null)
  const old = JSON.parse(memory[first]); old.savedAt = Date.now() - 86400001; memory[first] = JSON.stringify(old)
  assert.equal(readDraft(first), null)
  memory[first] = '{broken'; assert.equal(readDraft(first), null)
  assert.equal(compatibleDraft({ form: { title: 'Test', points: ['point'] } }, { form: { title: '', points: [] } }), true)
  assert.equal(compatibleDraft({ form: null }, { form: { title: '' } }), false)
  assert.equal(writeDraft(first, 'event', { text: 'x'.repeat(300000) }), false)
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError') } })
  assert.equal(writeDraft(first, 'event', { text: 'Retained in memory only' }), false); assert.equal(readDraft(first), null)
  assert.doesNotThrow(clearFormDrafts)
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
})
it('remembers only module filters, preserves explicit work context and clears private tab state on logout', () => {
  rememberModuleRoute('a', 'org', 'events', '?pointId=point2&tab=past&event=private-card&token=secret&location=old')
  const link = new URL(moduleRoute('a', 'org', 'events', 'current'), 'https://test.invalid')
  assert.equal(link.searchParams.get('pointId'), 'point2'); assert.equal(link.searchParams.get('location'), 'current')
  assert.equal(link.searchParams.has('event'), false); assert.equal(link.searchParams.has('token'), false)
  assert.equal(new URL(moduleRoute('b', 'org', 'events', 'current'), 'https://test.invalid').searchParams.has('pointId'), false)
  memory['staffly:report-job:a:org'] = 'test-only'
  memory['unrelated'] = 'preserved'
  clearFormDrafts()
  assert.equal(Object.keys(memory).some(key => key.startsWith('staffly:form-draft:') || key.startsWith('staffly:module-route:') || key.startsWith('staffly:report-job:')), false)
  assert.equal(memory.unrelated, 'preserved')
})
it('shows a bounded support reference while keeping temporary failures recoverable', async () => {
  const errorId = '6210c551-6270-4480-a4a3-7cb5383160e5'
  await assert.rejects(readJson(new Response(JSON.stringify({ message: 'Service unavailable', errorId }), { status: 503 })), error => {
    assert.equal((error as { errorId: string }).errorId, errorId)
    assert.match((error as Error).message, new RegExp(errorId)); return true
  })
  assert.match(connectionError(new TypeError('Failed to fetch'), true).message, /подтверждение/)
  assert.match(connectionError(new TypeError('Failed to fetch'), false).message, /соединение/)
})
