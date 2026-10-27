import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { authGet, authPost, useAuth } from '../../app/auth/auth-context.tsx'
import type { YandexPending } from '../../app/auth/yandex.ts'
import { safeReturnTo } from '../../app/auth/return-to.ts'
import { YandexMark } from '../../component/ui/yandex-button.tsx'
import AuthConsents from './auth-consents.tsx'
import './auth.scss'

export default function YandexCompletePage() {
  const navigate = useNavigate(), { completeYandex } = useAuth()
  const query = useQuery({ queryKey: ['yandex-pending'], queryFn: () => authGet<YandexPending>('yandex/pending'), retry: false, staleTime: Infinity })
  const [password, setPassword] = useState(''), [consentData, setConsentData] = useState(false), [consentTerms, setConsentTerms] = useState(false)
  const [attempted, setAttempted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const data = query.data
  async function cancel() {
    setBusy(true)
    try { await authPost('yandex/cancel', {}); navigate(`/auth?returnTo=${encodeURIComponent(safeReturnTo(data?.returnTo))}`, { replace: true }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отменить вход.'); setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setAttempted(true); setError('')
    if (!data || data.mode === 'register' && (!consentData || !consentTerms) || data.mode === 'connect' && !password) return
    setBusy(true)
    try {
      const result = await completeYandex(data.mode === 'register' ? { consentData, consentTerms } : { currentPassword: password })
      navigate(safeReturnTo(result.returnTo), { replace: true })
    } catch (failure) { setPassword(''); setError(failure instanceof Error ? failure.message : 'Не удалось завершить вход.'); setBusy(false) }
  }
  return <main className="auth"><div className="auth__panel auth__panel--message auth__yandex-panel">
    <Link className="auth__brand" to="/">Staffly</Link>
    <div className="auth__provider-label"><YandexMark /><span>Вход через Яндекс</span></div>
    {query.isPending ? <p role="status">Проверяем данные аккаунта…</p> : query.isError ? <><h1>Начните вход ещё раз</h1><p role="alert">{query.error instanceof Error ? query.error.message : 'Не удалось получить данные.'}</p><Link className="auth__text-button" to="/auth">Вернуться ко входу</Link></> : data && <>
      <h1>{data.mode === 'register' ? 'Завершите регистрацию' : 'Подключите Яндекс к аккаунту'}</h1>
      <div className="auth__yandex-identity"><strong>{[data.lastName, data.firstName].filter(Boolean).join(' ') || 'Аккаунт Яндекса'}</strong><span>{data.email}</span></div>
      <p>{data.mode === 'register' ? 'Создадим профиль Staffly с именем и аватаром из Яндекса. Пароль можно добавить позже в настройках.' : data.canConfirmPassword ? 'Аккаунт с этой почтой уже есть. Введите пароль Staffly, чтобы связать способы входа и сохранить ваши организации и данные.' : 'Аккаунт с этой почтой уже есть. Войдите привычным способом, подтвердите почту при необходимости и подключите Яндекс в настройках безопасности.'}</p>
      <form onSubmit={submit}>
        {data.mode === 'register' ? <AuthConsents consentData={consentData} consentTerms={consentTerms} onData={setConsentData} onTerms={setConsentTerms} attempted={attempted} /> : data.canConfirmPassword ? <div className="auth__field"><input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Пароль Staffly" aria-label="Пароль Staffly" maxLength={128} required /></div> : null}
        {error && <p className="auth__error" role="alert">{error}</p>}
        {(data.mode === 'register' || data.canConfirmPassword) && <button className="auth__submit" disabled={busy}>{busy ? 'Подождите…' : data.mode === 'register' ? 'Создать аккаунт' : 'Подключить и войти'}</button>}
        {data.mode === 'connect' && <Link className="auth__text-button" to="/forgot-password" state={{ email: data.email, returnTo: data.returnTo }}>Не помню пароль</Link>}
      </form>
      <button className="auth__text-button" type="button" disabled={busy} onClick={() => { void cancel() }}>{data.mode === 'connect' && !data.canConfirmPassword ? 'Вернуться ко входу' : 'Отмена'}</button>
    </>}
  </div></main>
}
