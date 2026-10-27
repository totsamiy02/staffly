import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { passwordRequirements, passwordValidationError } from '../../../../app/auth/password-policy.ts'
import { yandexMessage, type LoginMethods } from '../../../../app/auth/yandex.ts'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import YandexButton, { YandexMark, YandexLogo } from '../../../../component/ui/yandex-button.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import SensitiveCodeInput from '../../../../component/ui/sensitive-code-input.tsx'
import PasswordField from './password-field.tsx'
import './login-methods-settings.scss'

type Props = { methods?: LoginMethods; pending: boolean; failed: boolean; onReload: () => void }
type Dialog = 'link' | 'unlink' | 'password' | 'email' | 'email-code'
type Challenge = { challengeId: string; email: string; expiresAt: string }
const titles: Record<Dialog, string> = { link: 'Подключить Яндекс ID', unlink: 'Отключить Яндекс?', password: 'Создать пароль', email: 'Изменить почту', 'email-code': 'Подтвердите новую почту' }
const descriptions: Record<Dialog, string> = {
  link: 'Подтвердите текущий пароль Staffly, затем выберите аккаунт Яндекса. Остальные сеансы будут завершены после подключения.',
  unlink: 'Вход через Яндекс перестанет работать. Почта и пароль сохранятся. Остальные сеансы будут завершены.',
  password: 'Теперь у вас будет дополнительный способ входа. Используйте почту аккаунта Staffly и новый пароль.',
  email: 'Сначала подтвердим новый адрес кодом. После изменения почты все сеансы завершатся. Привязка Яндекса сохранится.',
  'email-code': 'Введите шестизначный код из письма. До подтверждения почта аккаунта останется прежней. Код действует 10 минут.',
}
export default function LoginMethodsSettings({ methods, pending, failed, onReload }: Props) {
  const { user, apiRequest, logout } = useAuth(), toast = useToast(), navigate = useNavigate(), location = useLocation()
  const [busy, setBusy] = useState(false), [dialog, setDialog] = useState<Dialog | null>(null)
  const [currentPassword, setCurrentPassword] = useState(''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('')
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState<Challenge | null>(null), [error, setError] = useState('')
  useEffect(() => {
    const params = new URLSearchParams(location.search), marker = params.get('yandex')
    if (!marker) return
    if (marker === 'password-ready' || marker === 'email-ready') {
      if (pending) return
      const ready = marker === 'password-ready' ? methods?.passwordSetupReady : methods?.emailChangeReady
      if (ready) setDialog(marker === 'password-ready' ? 'password' : 'email')
      else toast('Подтверждение истекло. Начните действие ещё раз.', 'error')
    } else {
      const message = marker === 'linked' ? 'Яндекс подключён. Теперь можно входить обоими способами.' : yandexMessage(marker)
      if (message) toast(message, marker === 'linked' ? 'success' : 'error')
    }
    params.delete('yandex'); navigate({ pathname: location.pathname, search: params.toString() }, { replace: true, state: location.state })
  }, [location, methods, pending, navigate, toast])
  function open(value: Dialog) { setError(''); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); setEmail(''); setCode(''); setChallenge(null); setDialog(value) }
  function close() {
    if (dialog === 'email-code' && challenge) void apiRequest('/auth/email-change/cancel', { method: 'POST', body: { challengeId: challenge.challengeId } }).catch(() => undefined)
    if (dialog === 'password' || dialog === 'email' && !methods?.hasPassword) void apiRequest('/auth/yandex/cancel', { method: 'POST', body: {} }).then(onReload).catch(() => undefined)
    setDialog(null); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); setCode(''); setChallenge(null); setError('')
  }
  async function reauthorize(purpose: 'password' | 'email') {
    setBusy(true)
    try { const result = await apiRequest<{ authorizationUrl: string }>(`/auth/yandex/${purpose}/start`, { method: 'POST', body: {} }); window.location.assign(result.authorizationUrl) }
    catch (failure) { toast(failure instanceof Error ? failure.message : 'Не удалось подтвердить Яндекс.', 'error'); setBusy(false) }
  }
  function startPassword() { if (methods?.passwordSetupReady) open('password'); else void reauthorize('password') }
  function startEmail() { if (methods?.hasPassword || methods?.emailChangeReady) open('email'); else void reauthorize('email') }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    if (dialog === 'password') { const issue = password !== confirmPassword ? 'Пароли не совпадают.' : passwordValidationError(password); if (issue) { setError(issue); return } }
    setBusy(true)
    try {
      if (dialog === 'link') {
        const result = await apiRequest<{ authorizationUrl: string }>('/auth/yandex/link', { method: 'POST', body: { currentPassword } })
        setCurrentPassword(''); window.location.assign(result.authorizationUrl); return
      }
      if (dialog === 'email') {
        const result = await apiRequest<Challenge>('/auth/email-change/start', { method: 'POST', body: { email, ...(methods?.hasPassword ? { currentPassword } : {}) } })
        setCurrentPassword(''); setChallenge(result); setDialog('email-code'); onReload(); return
      }
      if (dialog === 'email-code') {
        const result = await apiRequest<{ message: string }>('/auth/email-change/confirm', { method: 'POST', body: { challengeId: challenge?.challengeId, code } })
        await logout(); navigate('/auth?mode=login', { replace: true }); toast(result.message, 'success'); return
      }
      const result = await apiRequest<{ message: string }>(`/auth/yandex/${dialog === 'password' ? 'password/complete' : 'unlink'}`, { method: 'POST', body: dialog === 'password' ? { password, confirmPassword } : { currentPassword } })
      setDialog(null); setCurrentPassword(''); setPassword(''); setConfirmPassword(''); toast(result.message, 'success'); onReload()
    } catch (failure) { setCurrentPassword(''); setError(failure instanceof Error ? failure.message : 'Не удалось сохранить изменения.') }
    finally { setBusy(false) }
  }
  return <section className="sessions-editor login-methods"><header><div><p className="app-eyebrow">Доступ к аккаунту</p><h2>Способы входа</h2><p>Яндекс и пароль открывают один аккаунт. Данные профиля можно менять независимо от Яндекса.</p></div></header>
    {pending ? <p role="status">Загружаем способы входа…</p> : failed ? <div className="app-state"><p>Не удалось загрузить способы входа.</p><button className="app-secondary" onClick={onReload}>Повторить</button></div> : methods && <>
      {!methods.hasPassword && <p className="login-methods__notice">Сейчас вы можете войти только через Яндекс. При желании создайте пароль — он поможет войти, если Яндекс временно недоступен.</p>}
      <div className="login-methods__list">
        <article><MailIcon /><div><strong>Почта аккаунта</strong><span>{user?.email}</span><small>Для писем Staffly и входа по паролю</small></div><button className="app-secondary" disabled={busy || !methods.hasPassword && !methods.yandex.enabled} onClick={startEmail}>Изменить почту</button></article>
        <article><span className="login-methods__email-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg></span><div><strong>Пароль</strong><span className={`login-methods__state${methods.hasPassword ? ' is-connected' : ''}`}>{methods.hasPassword ? 'Установлен' : 'Ещё не создан'}</span>{!methods.hasPassword && <small>Перед созданием подтвердите подключённый Яндекс ID.</small>}</div>{!methods.hasPassword && <button className="app-secondary" disabled={busy || !methods.yandex.enabled} onClick={startPassword}>Создать пароль</button>}</article>
        <article className="login-methods__provider"><YandexMark /><div><strong className="login-methods__provider-title"><YandexLogo /></strong><span className={`login-methods__state${methods.yandex.connected ? ' is-connected' : ''}`}>{methods.yandex.connected ? 'Подключён' : 'Не подключён'}</span>{methods.yandex.email && <small>{methods.yandex.email}</small>}{methods.yandex.connected && !methods.hasPassword && <small>Для отключения сначала создайте пароль.</small>}</div>{methods.yandex.connected ? methods.hasPassword && <button className="app-secondary" disabled={busy} onClick={() => open('unlink')}>Отключить</button> : methods.yandex.enabled ? <button className="app-secondary" disabled={busy} onClick={() => open('link')}>Подключить</button> : <span className="login-methods__unavailable">Пока недоступен</span>}</article>
      </div>
    </>}
    {dialog && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={close}>{requestClose => <DocumentDialog eyebrow="Безопасность" title={titles[dialog]} description={descriptions[dialog]} busy={busy} onClose={requestClose} className="login-methods__dialog"><form onSubmit={submit}>
      {dialog === 'link' && <div className="login-methods__provider-banner"><YandexLogo /><span>Подключение к аккаунту Staffly</span></div>}
      {dialog === 'email' && <label><span>Новая почта</span><input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" maxLength={254} required /></label>}
      {(dialog === 'link' || dialog === 'unlink' || dialog === 'email' && methods?.hasPassword) && <PasswordField label="Текущий пароль Staffly" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />}
      {dialog === 'password' && <><PasswordField label="Новый пароль" value={password} onChange={setPassword} autoComplete="new-password" /><PasswordField label="Повторите пароль" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" /><div className="password-requirements" aria-label="Требования к паролю">{passwordRequirements.map(rule => <span className={password && rule.test(password) ? 'password-requirement password-requirement--valid' : 'password-requirement'} key={rule.label}>{rule.label}</span>)}</div></>}
      {dialog === 'email-code' && <><p className="login-methods__target">Код отправлен на <strong>{challenge?.email}</strong></p><SensitiveCodeInput value={code} onChange={setCode} label="Код подтверждения новой почты" /></>}
      {error && <p role="alert" className="form-inline-error">{error}</p>}
      <footer><button type="button" className="app-secondary" disabled={busy} onClick={requestClose}>Отмена</button>{dialog === 'link' ? <YandexButton type="submit" busy={busy} /> : <button className="app-primary" disabled={busy || dialog === 'email-code' && code.length !== 6}>{busy ? 'Подождите…' : dialog === 'unlink' ? 'Отключить Яндекс' : dialog === 'password' ? 'Создать пароль' : dialog === 'email' ? 'Получить код' : 'Подтвердить почту'}</button>}</footer>
    </form></DocumentDialog>}</AnimatedOverlay>}
  </section>
}
function MailIcon() { return <span className="login-methods__email-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg></span> }
