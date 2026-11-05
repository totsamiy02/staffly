import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'
import AnimatedOverlay from '../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../component/ui/modal/document-dialog.tsx'

import { FormSafetyContext as Context, type FormGuard } from './form-safety-context.ts'
type Choice = 'stay' | 'discard' | 'draft'
type Pending = { guards: FormGuard[]; resolve: (choice: Choice) => void }
export default function FormSafetyProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<symbol, FormGuard>()).current
  const [protectedForm, setProtectedForm] = useState(false)
  const notify = useCallback(() => setProtectedForm([...guards.values()].some(item => item.dirty || item.busy)), [guards])
  const [pending, setPending] = useState<Pending | null>(null), [error, setError] = useState('')
  const pendingRef = useRef<Pending | null>(null)
  const confirm = useCallback(async (items: FormGuard[]) => {
    const changed = items.filter(item => item.dirty || item.busy)
    if (!changed.length) return true
    if (pendingRef.current) return false
    const choice = await new Promise<Choice>(resolve => {
      const next = { guards: changed, resolve }; pendingRef.current = next; setPending(next); setError('')
    })
    if (choice === 'stay') return false
    if (choice === 'discard') changed.forEach(item => item.discard())
    return true
  }, [])
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) &&
    [...guards.values()].some(item => item.dirty || item.busy))
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    void confirm([...guards.values()]).then(leave => {
      if (leave) blocker.proceed(); else blocker.reset()
    })
  }, [blocker, confirm, guards])
  useEffect(() => {
    if (!protectedForm) return
    const unload = (event: BeforeUnloadEvent) => {
      const changed = [...guards.values()].filter(item => item.dirty || item.busy)
      if (!changed.length) return
      changed.forEach(item => item.saveDraft?.())
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [guards, protectedForm])
  useEffect(() => () => { pendingRef.current?.resolve('stay') }, [])
  function choose(choice: Choice) {
    if (!pending) return
    if (choice === 'draft' && !pending.guards.every(item => !item.dirty || item.saveDraft?.())) {
      setError('Не удалось сохранить черновик в этой вкладке. Продолжите редактирование или выйдите без сохранения.'); return
    }
    const current = pending; pendingRef.current = null; setPending(null); current.resolve(choice)
  }
  const canDraft = pending && !pending.guards.some(item => item.busy) && pending.guards.every(item => !item.dirty || !!item.saveDraft)
  return <Context.Provider value={{ guards, confirm, notify }}>{children}{pending && <AnimatedOverlay variant="modal" onClose={() => choose('stay')}>{close => <DocumentDialog title="Есть несохранённые изменения" eyebrow="Изменения формы" onClose={close}>
    <p>{pending.guards.some(item => item.busy) ? 'Запрос ещё выполняется. Если уйти сейчас, операция может завершиться на сервере. Лучше дождаться результата.' : 'Изменения ещё не отправлены на сервер. При выходе без сохранения они будут удалены.'}</p>
    {canDraft && <p>Можно оставить черновик на 24 часа в этой вкладке браузера. Он будет удалён при выходе из аккаунта.</p>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button className="app-secondary" type="button" onClick={() => choose('stay')}>Продолжить редактирование</button><button className="app-secondary" type="button" onClick={() => choose('discard')}>Выйти без сохранения</button>{canDraft && <button className="app-primary" type="button" onClick={() => choose('draft')}>Сохранить черновик и выйти</button>}</footer>
  </DocumentDialog>}</AnimatedOverlay>}</Context.Provider>
}
