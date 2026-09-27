import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ToastContext } from './toast-context.ts'
import './toast.scss'

type Kind = 'success' | 'error' | 'info'
type Entry = { id: number; message: string; kind: Kind; closing?: boolean }
export default function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const sequence = useRef(0)
  const timers = useRef(new Set<number>())
  const later = useCallback((fn: () => void, delay: number) => {
    const id = window.setTimeout(() => { timers.current.delete(id); fn() }, delay)
    timers.current.add(id)
  }, [])
  const dismiss = useCallback((id: number) => {
    setEntries(current => current.map(entry => entry.id === id ? { ...entry, closing: true } : entry))
    later(() => setEntries(current => current.filter(entry => entry.id !== id)), 180)
  }, [later])
  const toast = useCallback((message: string, kind: Kind = 'info') => {
    const id = ++sequence.current
    setEntries(current => [...current, { id, message, kind }].slice(-4))
    later(() => dismiss(id), kind === 'error' ? 6500 : 4500)
  }, [dismiss, later])
  useEffect(() => { const pending = timers.current; return () => { pending.forEach(window.clearTimeout); pending.clear() } }, [])
  return <ToastContext.Provider value={toast}>{children}{createPortal(<div className="staffly-toasts" aria-label="Результаты действий">{entries.map(entry => <div key={entry.id} className={`staffly-toast staffly-toast--${entry.kind}${entry.closing ? ' is-closing' : ''}`} role={entry.kind === 'error' ? 'alert' : 'status'}><span aria-hidden="true">{entry.kind === 'success' ? '✓' : entry.kind === 'error' ? '!' : 'i'}</span><p>{entry.message}</p><button aria-label="Закрыть сообщение" onClick={() => dismiss(entry.id)}>×</button></div>)}</div>, document.body)}</ToastContext.Provider>
}
