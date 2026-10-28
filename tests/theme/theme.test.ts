import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bootstrap = readFileSync(path.join(root, 'public/theme-init.js'), 'utf8')
const storeSource = readFileSync(path.join(root, 'src/app/theme/theme-store.ts'), 'utf8')
const compiled = ts.transpileModule(storeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText

type Store = typeof import('../../src/app/theme/theme-store.ts')
function environment({ saved, systemDark = false, blocked = false }: { saved?: string; systemDark?: boolean; blocked?: boolean } = {}) {
  const values = new Map<string, string>(saved ? [['staffly.theme', saved]] : [])
  const events = new Map<string, Set<(event: unknown) => void>>()
  const mediaListeners = new Set<() => void>()
  const storage = { getItem(key: string) { if (blocked) throw Error('Blocked'); return values.get(key) ?? null }, setItem(key: string, value: string) { if (blocked) throw Error('Blocked'); values.set(key, value) } }
  const media = { matches: systemDark, addEventListener(_type: string, listener: () => void) { mediaListeners.add(listener) }, removeEventListener(_type: string, listener: () => void) { mediaListeners.delete(listener) } }
  const document = { documentElement: { dataset: {} as { theme?: string }, style: { colorScheme: '' } } }
  const window = { matchMedia() { return media }, get localStorage() { if (blocked) throw Error('Blocked'); return storage }, addEventListener(type: string, listener: (event: unknown) => void) { const group = events.get(type) ?? new Set(); group.add(listener); events.set(type, group) }, removeEventListener(type: string, listener: (event: unknown) => void) { events.get(type)?.delete(listener) } }
  const context = vm.createContext({ document, window, localStorage: storage, exports: {} })
  return { context, document, values, mediaListeners, events,
    load() { vm.runInContext(bootstrap, context); vm.runInContext(compiled, context); return context.exports as Store },
    changeSystem(dark: boolean) { media.matches = dark; for (const listener of mediaListeners) listener() },
    storageEvent(key: string | null, newValue: string | null, storageArea: unknown = null) { for (const listener of events.get('storage') ?? []) listener({ key, newValue, storageArea }) },
  }
}

test('first paint and React store agree for saved, system, invalid and blocked preferences', () => {
  for (const [options, expected] of [[{ systemDark: true }, 'dark'], [{ systemDark: false }, 'light'], [{ saved: 'light', systemDark: true }, 'light'], [{ saved: 'dark', systemDark: false }, 'dark'], [{ saved: 'invalid', systemDark: true }, 'dark'], [{ blocked: true, systemDark: true }, 'dark']] as const) {
    const env = environment(options)
    const store = env.load()
    assert.equal(env.document.documentElement.dataset.theme, expected)
    assert.equal(env.document.documentElement.style.colorScheme, expected)
    assert.equal(store.getTheme(), expected)
    const stop = store.startThemeSync()
    assert.equal(store.getTheme(), expected)
    stop()
  }
})

test('rapid toggles persist the final choice and update all subscribers without remounting', () => {
  const env = environment(); const store = env.load(); const stop = store.startThemeSync()
  const seen: string[] = []; let other = ''
  const unsubscribe = store.subscribeTheme(() => seen.push(store.getTheme()))
  const unsubscribeOther = store.subscribeTheme(() => { other = store.getTheme() })
  for (let click = 0; click < 5; click++) store.toggleTheme()
  assert.deepEqual(seen, ['dark', 'light', 'dark', 'light', 'dark'])
  assert.equal(other, 'dark')
  assert.equal(env.document.documentElement.dataset.theme, 'dark')
  assert.equal(env.values.get('staffly.theme'), 'dark')
  unsubscribe(); unsubscribeOther(); stop()
})

test('explicit choice wins over system changes; storage updates and reset synchronize other tabs', () => {
  const env = environment(); const store = env.load(); const stop = store.startThemeSync()
  env.changeSystem(true); assert.equal(store.getTheme(), 'dark')
  store.setTheme('light'); env.changeSystem(false); env.changeSystem(true)
  assert.equal(store.getTheme(), 'light')
  env.storageEvent('unrelated', 'dark'); assert.equal(store.getTheme(), 'light')
  env.storageEvent('staffly.theme', 'dark', {}); assert.equal(store.getTheme(), 'light')
  env.storageEvent('staffly.theme', 'dark'); assert.equal(store.getTheme(), 'dark')
  env.changeSystem(false); assert.equal(store.getTheme(), 'dark')
  env.storageEvent('staffly.theme', null); assert.equal(store.getTheme(), 'light')
  env.changeSystem(true); assert.equal(store.getTheme(), 'dark')
  env.storageEvent(null, null); assert.equal(store.getTheme(), 'dark')
  stop()
})

test('blocked storage still allows manual changes and ignores later system updates', () => {
  const env = environment({ blocked: true }); const store = env.load(); const stop = store.startThemeSync()
  assert.doesNotThrow(() => store.setTheme('dark'))
  assert.equal(store.getTheme(), 'dark')
  env.changeSystem(true); env.changeSystem(false)
  assert.equal(store.getTheme(), 'dark')
  assert.doesNotThrow(() => env.storageEvent('staffly.theme', 'light', {}))
  assert.equal(store.getTheme(), 'dark')
  stop()
})

test('root subscriptions clean up across StrictMode mount/unmount and headers changing routes', () => {
  const env = environment(); const store = env.load()
  const first = store.startThemeSync(); first()
  assert.equal(env.mediaListeners.size, 0); assert.equal(env.events.get('storage')?.size, 0)
  const second = store.startThemeSync()
  assert.equal(env.mediaListeners.size, 1); assert.equal(env.events.get('storage')?.size, 1)
  second(); env.changeSystem(true)
  assert.equal(store.getTheme(), 'light')
})

const themeCss = readFileSync(path.join(root, 'src/styles/theme.scss'), 'utf8')
test('shared dark text and semantic status colors maintain readable contrast', () => {
  const darkPalette = themeCss.match(/:root\[data-theme=dark\]\s*\{([^}]+)\}/)![1]
  const colors = new Map([...darkPalette.matchAll(/--theme-([\w-]+):\s*(#[0-9a-f]{6})/g)].map(match => [match[1], match[2]]))
  function luminance(hex: string) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
  }
  for (const [text, background] of [['text-strong', 'canvas'], ['text', 'surface'], ['muted', 'surface'], ['quiet', 'surface'], ['online', 'surface'], ['online', 'surface-muted'], ['primary-ink', 'primary'], ['primary-ink', 'accent'], ...['accent', 'rose', 'danger', 'warning', 'success', 'teal'].map(name => [name, `${name}-bg`])]) {
    const a = luminance(colors.get(text)!), b = luminance(colors.get(background)!)
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    assert.ok(ratio >= 4.5, `${text}/${background}: ${ratio.toFixed(2)}`)
  }
})

test('every migrated UI color role is supplied by the root dark palette, also for lazy routes and portals', () => {
  const definitions = new Set([...themeCss.matchAll(/--theme-([\w-]+):/g)].map(match => match[1]))
  const files = readdirSync(path.join(root, 'src'), { recursive: true }).filter(file => String(file).endsWith('.scss'))
  for (const file of files) {
    const source = readFileSync(path.join(root, 'src', String(file)), 'utf8')
    for (const match of source.matchAll(/var\(--theme-([\w-]+)/g)) assert.ok(definitions.has(match[1]), `${file}: undefined ${match[1]}`)
  }
  const html = readFileSync(path.join(root, 'index.html'), 'utf8')
  assert.ok(html.indexOf('<script src="/theme-init.js"></script>') < html.indexOf('<body>'))
  assert.doesNotMatch(html, /<script[^>]+(?:async|defer)[^>]+theme-init/)
})
