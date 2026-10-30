import { liveQueryOptions } from '../../../app/live-query.ts'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { safeReturnTo } from '../../../app/auth/return-to.ts'
import type { LoginMethods } from '../../../app/auth/yandex.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import './password-setup-reminder.scss'

function wasOffered(key: string) {
  try { return window.sessionStorage.getItem(key) === '1' } catch { return false }
}

export default function PasswordSetupReminder() {
  const { user, apiRequest } = useAuth(), location = useLocation()
  const key = `staffly:password-offered:${user?.id}`
  const [dismissed, setDismissed] = useState(() => wasOffered(key))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const methods = useQuery({ ...liveQueryOptions, queryKey: ['auth-login-methods', user?.id], queryFn: () => apiRequest<LoginMethods>('/auth/yandex/methods'), enabled: Boolean(user), staleTime: 30_000 })
  if (!user || !methods.data || methods.data.hasPassword) return null
  const returnTo = safeReturnTo(location.pathname + location.search + location.hash)
  const securityPage = location.pathname === '/app/settings' && new URLSearchParams(location.search).get('section') === 'security'
  const offered = !dismissed && !securityPage && !new URLSearchParams(location.search).has('yandex')
  function close() {
    setDismissed(true)
    try { window.sessionStorage.setItem(key, '1') } catch { /* The banner stays available when storage is blocked. */ }
  }
  async function createPassword() {
    setBusy(true); setError('')
    try {
      const result = await apiRequest<{ authorizationUrl: string }>('/auth/yandex/password/start', { method: 'POST', body: { returnTo } })
      close(); window.location.assign(result.authorizationUrl)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось начать создание пароля.'); setBusy(false) }
  }
  return <>
    <aside className="password-reminder" aria-label="Запасной способ входа">
      <span className="password-reminder__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m4 4v3" /></svg></span>
      <div><strong>Добавьте запасной пароль</strong><p>Яндекс ID работает без него. Запасной пароль поможет, если вход через Яндекс станет недоступен.</p></div>
      <Link to={securityPage ? '/app/settings?section=security#login-methods' : `/app/settings?section=security&returnTo=${encodeURIComponent(returnTo)}`} onClick={() => { close(); if (securityPage) document.getElementById('login-methods')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>Создать пароль</Link>
    </aside>
    {offered && createPortal(<AnimatedOverlay variant="modal" dismissible={!busy} onClose={close}>{requestClose => <DocumentDialog eyebrow="Безопасность аккаунта" title="Добавьте запасной способ входа" description="Вы вошли через Яндекс ID. Пароля Staffly у вас пока нет — создайте его, чтобы входить ещё и по почте." busy={busy} onClose={requestClose} className="password-reminder-dialog">
      <div className="password-reminder-dialog__email"><span>Почта вашего аккаунта</span><strong>{user.email}</strong></div>
      <p>Перед созданием подтвердите подключённый Яндекс ID. Вход через Яндекс сохранится, даже если вы выберете «Позже».</p>
      <p>Если потеряете доступ к Яндексу, сможете задать пароль кодом на эту почту через «Забыли пароль?». Без доступа к Яндексу и почте восстановить аккаунт самостоятельно не получится.</p>
      {error && <p className="form-inline-error" role="alert">{error}</p>}
      <footer><button type="button" className="app-secondary" disabled={busy} onClick={requestClose}>Позже</button><button type="button" className="app-primary" disabled={busy || !methods.data.yandex.enabled} onClick={() => void createPassword()}>{busy ? 'Переходим к Яндексу…' : 'Создать пароль'}</button></footer>
      {!methods.data.yandex.enabled && <Link className="password-reminder-dialog__recovery" to="/forgot-password" state={{ email: user.email, returnTo: location.pathname + location.search }} onClick={close}>Подтвердить почту и создать пароль</Link>}
    </DocumentDialog>}</AnimatedOverlay>, document.body)}
  </>
}
