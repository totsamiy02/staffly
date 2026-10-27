import { useSyncExternalStore } from 'react'
import { getServerTheme, getTheme, subscribeTheme, toggleTheme } from '../../../app/theme/theme-store.ts'
import './theme-toggle.scss'

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme)
  const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
  return <button type="button" className="theme-toggle" aria-label={label} title={label} aria-pressed={theme === 'dark'} onClick={toggleTheme}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{theme === 'dark' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></> : <path d="M20.6 14.1A9 9 0 0 1 9.9 3.4a9 9 0 1 0 10.7 10.7Z" />}</svg>
  </button>
}
