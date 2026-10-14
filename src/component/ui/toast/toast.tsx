import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ToastContext, FloatingMessagesContext, type FloatingMessage } from './toast-context.ts'
import { enqueueMessage } from './message-queue.ts'
import './toast.scss'
import { useAuth } from '../../../app/auth/auth-context.tsx'

type Kind = 'success' | 'error' | 'info'
export default function ToastProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [queue, setQueue] = useState<FloatingMessage[]>([])
  const [phase, setPhase] = useState<'show' | 'closing' | 'gap'>('show')
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')
  const sequence = useRef(0)
  const active = queue[0]
  const activeId = useRef<string | undefined>(undefined)
  const closingId = useRef<string | undefined>(undefined)
  activeId.current = active?.id
  const enqueue = useCallback((entry: FloatingMessage) => setQueue(current => enqueueMessage(current, entry)), [])
  const dismiss = useCallback((id: string) => {
    if (activeId.current === id) { closingId.current = id; setPhase('closing') }
    else setQueue(current => current.filter(item => item.id !== id))
  }, [])
  const remove = useCallback((id: string) => setQueue(current => current.filter(item => item.id !== id)), [])
  const duration = active?.duration, currentId = active?.id
  useEffect(() => { setQueue([]); setPhase('show') }, [user?.id])
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useEffect(() => {
    if (!currentId || !pageVisible || phase !== 'show') return
    const timer = window.setTimeout(() => dismiss(currentId), duration)
    return () => window.clearTimeout(timer)
  }, [currentId, duration, pageVisible, phase, dismiss])
  useEffect(() => {
    if (phase === 'show') return
    const timer = window.setTimeout(() => {
      if (phase === 'closing') { const id = closingId.current; setPhase('gap'); setQueue(current => current.filter(item => item.id !== id)) }
      else setPhase('show')
    }, phase === 'closing' ? 180 : 800)
    return () => window.clearTimeout(timer)
  }, [phase])
  const toast = useCallback((message: string, kind: Kind = 'info') => {
    const id = `toast:${++sequence.current}`
    enqueue({ id, duration: kind === 'error' ? 6500 : 4000, className: `staffly-toast staffly-toast--${kind}`, content: <><span aria-hidden="true">{kind === 'success' ? '✓' : kind === 'error' ? '!' : 'i'}</span><p>{message}</p><button aria-label="Закрыть сообщение" onClick={() => dismiss(id)}>×</button></> })
  }, [enqueue, dismiss])
  return <ToastContext.Provider value={toast}><FloatingMessagesContext.Provider value={{enqueue,dismiss,remove}}>{children}{createPortal(<div className="staffly-notification-stack" aria-label="Уведомления">{active && phase !== 'gap' && <div key={active.id} className={`${active.className}${phase === 'closing' ? ' is-closing' : ''}`} role="status">{active.content}</div>}</div>, document.body)}</FloatingMessagesContext.Provider></ToastContext.Provider>
}
