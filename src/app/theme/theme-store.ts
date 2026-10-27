export type Theme = 'light' | 'dark'
export const THEME_STORAGE_KEY = 'staffly.theme'
const systemQuery = '(prefers-color-scheme: dark)'
const listeners = new Set<() => void>()

export function parseTheme(value: string | null | undefined): Theme | null {
  return value === 'light' || value === 'dark' ? value : null
}

function readPreference(): Theme | null {
  try { return parseTheme(localStorage.getItem(THEME_STORAGE_KEY)) } catch { return null }
}
function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.(systemQuery).matches ? 'dark' : 'light'
}
let preference = typeof window === 'undefined' ? null : readPreference()
let current: Theme = preference ?? systemTheme()

function apply(theme: Theme) {
  current = theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  for (const listener of listeners) listener()
}

export const getTheme = () => current
export const getServerTheme = (): Theme => 'light'
export function subscribeTheme(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setTheme(theme: Theme) {
  preference = theme
  apply(theme)
  try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* The current tab still switches. */ }
}
export function toggleTheme() { setTheme(current === 'dark' ? 'light' : 'dark') }

/** One root subscription also covers routes with no header and body portals. */
export function startThemeSync() {
  const media = window.matchMedia?.(systemQuery)
  function systemChanged() { if (!preference) apply(systemTheme()) }
  function storageChanged(event: StorageEvent) {
    try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    preference = parseTheme(event.newValue)
    apply(preference ?? systemTheme())
  }
  apply(preference ?? systemTheme())
  media?.addEventListener('change', systemChanged)
  window.addEventListener('storage', storageChanged)
  return () => {
    media?.removeEventListener('change', systemChanged)
    window.removeEventListener('storage', storageChanged)
  }
}
