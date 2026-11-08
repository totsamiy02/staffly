import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import { useAdmin } from '../admin-data.tsx'
import { AdminIcon } from '../admin-elements.tsx'
import { managementActions } from './catalog.ts'
import type { ActionSpec, ManagementActionStatus, ManagementResult } from './contracts.ts'
type Challenge = { challengeId: string; summary: string; expiresAt: string; retryAt: string; attemptsRemaining: number }
export type ProtectedAction = { spec: ActionSpec; description: string; onReturn?: () => void; onCompleted?: () => void }
type Failure = Error & { code?: string; retryAfterMs?: number }
function ActionSurface({ action, close, onDone, busy, setBusy, onIssued }: {
  action: ProtectedAction; close: () => void; onDone: (result: ManagementResult) => void; busy: boolean; setBusy: (value: boolean) => void; onIssued: (id: string | null) => void
}) {
  const { request } = useAdmin(), ref = useRef<HTMLDivElement>(null), pending = useRef(false)
  const [password, setPassword] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState<Challenge | null>(null)
  const [error, setError] = useState<Error | null>(null), [invalid, setInvalid] = useState(false), [terminal, setTerminal] = useState(false), [uncertain, setUncertain] = useState(false)
  const [now, setNow] = useState(Date.now()), [retryAt, setRetryAt] = useState(0)
  useDialogFocus(ref)
  useLayoutEffect(() => { ref.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus({ preventScroll: true }) }, [challenge?.challengeId, invalid])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const expired = terminal || Boolean(challenge && now >= Date.parse(challenge.expiresAt)), waiting = now < retryAt
  const seconds = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0
  async function reconcile(originalError?: Error) {
    if (!challenge) return null
    try {
      const state = await request<ManagementActionStatus>('/management/actions/' + challenge.challengeId)
      setUncertain(false)
      if (state.state === 'completed') { onIssued(null); onDone({ ok: true, resourceId: state.resourceId }); return state }
      setChallenge(current => current ? { ...current, expiresAt: state.expiresAt, retryAt: state.retryAt, attemptsRemaining: state.attemptsRemaining } : current)
      setRetryAt(Date.parse(state.retryAt))
      setTerminal(state.state !== 'pending')
      setError(originalError ?? (state.state === 'pending' ? new Error('Действие ещё не выполнено. Можно повторить подтверждение тем же кодом.') : new Error('Подтверждение завершено или код истёк. Подготовьте действие заново.')))
      return state
    } catch (failure) {
      setUncertain(true)
      setError(failure instanceof Error ? failure : new Error('Не удалось проверить результат.'))
      return null
    }
  }
  async function verifyResult() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { await reconcile() } finally { pending.current = false; setBusy(false) }
  }
  async function renew() {
    if (!challenge || pending.current || uncertain) return
    pending.current = true; setBusy(true)
    try {
      const state = await reconcile()
      if (!state || state.state === 'completed') return
      await request('/management/actions/' + challenge.challengeId + '/cancel', { method: 'POST', body: {} })
      setChallenge(null); onIssued(null); setPassword(''); setCode(''); setTerminal(false); setInvalid(false); setError(null)
    } catch (failure) { setUncertain(true); setError(failure instanceof Error ? failure : new Error('Не удалось обновить подтверждение.')) }
    finally { pending.current = false; setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending.current || expired || uncertain || !challenge && waiting) return
    pending.current = true; setBusy(true); setError(null); setInvalid(false)
    try {
      if (!challenge) {
        const next = await request<Challenge>('/management/actions', { method: 'POST', body: { spec: action.spec, password } })
        setPassword(''); setChallenge(next); setRetryAt(Date.parse(next.retryAt)); onIssued(next.challengeId); setNow(Date.now())
      } else {
        const result = await request<ManagementResult>('/management/actions/execute', { method: 'POST', body: { challengeId: challenge.challengeId, code, confirm: true } })
        setCode(''); onIssued(null); onDone(result)
      }
    } catch (failure) {
      const problem = failure as Failure
      setInvalid(true); setError(problem); setCode('')
      if (challenge) await reconcile(problem)
      else if (problem.code === 'ADMIN_ACTION_WAIT') setRetryAt(Date.now() + Math.max(60000, problem.retryAfterMs ?? 0))
    } finally { pending.current = false; setBusy(false) }
  }
  return <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-action-title" className="admin-ops-dialog admin-management-dialog">
    <header><div className="admin-auth-symbol"><AdminIcon name="shield" /></div><button type="button" className="admin-icon-button" aria-label="Закрыть подтверждение" disabled={busy} onClick={close}><AdminIcon name="close" /></button></header>
    <div className="admin-eyebrow">Защищённое действие · {challenge ? '2' : '1'} из 2</div><h2 id="admin-action-title">{managementActions[action.spec.action]}</h2><p>{challenge?.summary ?? action.description}</p>
    <form onSubmit={event => void submit(event)} className={invalid ? 'has-action-error' : ''}>
      {challenge ? <label key="code" className="admin-management-field"><span>Код из письма</span><input autoFocus name="management-confirmation" type="text" aria-label="Код из письма" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" data-1p-ignore="true" data-lpignore="true" spellCheck={false} value={code} disabled={busy || expired || uncertain} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} className="admin-action-otp" required /><small>{expired ? 'Код истёк или подтверждение больше недоступно.' : `До истечения кода: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. Осталось попыток: ${challenge.attemptsRemaining}.`}</small></label> : <label key="password" className="admin-management-field"><span>Пароль вашего аккаунта</span><input autoFocus type="password" aria-label="Пароль вашего аккаунта" autoComplete="current-password" name="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={1024} required /><small>После проверки отправим на вашу почту разовый код с описанием действия.</small></label>}
      {!challenge && waiting && <p role="status">Повторная отправка доступна через {Math.ceil((retryAt - now) / 1000)} с.</p>}
      {uncertain && <p className="admin-notice" role="status">Результат пока не подтверждён. Проверьте его перед новым действием.</p>}
      {error && <div role="alert"><RequestErrorMessage error={error} /></div>}
      <div className="admin-actions"><button type="button" className="admin-btn" disabled={busy} onClick={close}>{action.onReturn ? 'Вернуться к параметрам' : 'Отмена'}</button>
        {uncertain ? <button type="button" className="admin-btn admin-btn--primary" disabled={busy} onClick={() => void verifyResult()}>Проверить результат</button> : expired ? <button type="button" className="admin-btn admin-btn--primary" disabled={busy} onClick={() => void renew()}>Подготовить заново</button> : <button className="admin-btn admin-btn--primary" disabled={busy || (challenge ? code.length !== 6 : !password || waiting)}>{busy ? 'Проверяем…' : challenge ? 'Подтвердить действие' : 'Получить код'}</button>}
      </div>
    </form>
  </section>
}
export function ManagementActionDialog({ action, onClose, onDone }: { action: ProtectedAction; onClose: () => void; onDone: (result: ManagementResult) => void }) {
  const [busy, setBusy] = useState(false), issued = useRef<string | null>(null), { request } = useAdmin()
  const cancel = () => { if (issued.current) void request('/management/actions/' + issued.current + '/cancel', { method: 'POST', body: {} }).catch(() => {}); onClose() }
  return <AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay" dismissible={!busy} onClose={cancel}>{close => <ActionSurface action={action} close={close} busy={busy} setBusy={setBusy} onIssued={id => { issued.current = id }} onDone={onDone} />}</AnimatedOverlay>
}
