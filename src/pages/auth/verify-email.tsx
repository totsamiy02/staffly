import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authPost, useAuth } from '../../app/auth/auth-context.tsx'
import { safeReturnTo } from '../../app/auth/return-to.ts'
import { passwordRequirements, passwordValidationError } from '../../app/auth/password-policy.ts'
import AuthConsents from './auth-consents.tsx'
import CodeInput from './code-input.tsx'
import './auth.scss'

function VerifyEmailPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { verifyEmail } = useAuth()
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '')
  const initialEmail = (location.state as { email?: string } | null)?.email
  const returnTo = safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [consentData, setConsentData] = useState(false)
  const [consentTerms, setConsentTerms] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(() => (location.state as { cooldownUntil?: number } | null)?.cooldownUntil ?? 0)
  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    const issue = passwordValidationError(password) || (password !== confirmPassword ? 'Пароли не совпадают.' : '')
    if (issue) { setError(issue); return }
    if (!consentData || !consentTerms) { setError('Подтвердите согласия для регистрации.'); return }
    setBusy(true)
    setError('')
    try {
      await verifyEmail({ email, code, password, confirmPassword, consentData, consentTerms })
      navigate(returnTo, { replace: true })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось подтвердить почту.')
    } finally { setBusy(false) }
  }

  async function resend() {
    setBusy(true)
    setError('')
    try {
      const result = await authPost<{ message: string }>('resend-verification', { email })
      setNotice(result.message)
      setCooldownUntil(Date.now() + 60_000)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось отправить код.')
    } finally { setBusy(false) }
  }

  return <main className="auth"><div className="auth__panel auth__panel--message">
    <Link className="auth__back" to="/">На главную</Link>
    <Link className="auth__brand" to="/">Staffly</Link>
    <h1>Завершите регистрацию</h1>
    <p>Введите код из письма. Он действует 10 минут.{initialEmail && <> Письмо отправлено на <strong>{initialEmail}</strong>.</>}</p>
    <form onSubmit={submit}>
      {!initialEmail && <div className="auth__field"><input type="email" aria-label="Электронная почта" placeholder="Электронная почта" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>}
      <div className="auth__fields">
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <CodeInput label="Код подтверждения" value={code} onChange={setCode} />
        <div className="auth__field"><input type="password" name="new-password" aria-label="Придумайте пароль" placeholder="Придумайте пароль" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required /></div>
        <div className="auth__password-requirements">{passwordRequirements.map(rule => <span className={password && rule.test(password) ? 'auth__password-rule auth__password-rule--valid' : 'auth__password-rule'} key={rule.label}>{rule.label}</span>)}</div>
        <div className="auth__field"><input type="password" name="confirm-password" aria-label="Повторите пароль" placeholder="Повторите пароль" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required /></div>
      </div>
      <AuthConsents consentData={consentData} consentTerms={consentTerms} onData={setConsentData} onTerms={setConsentTerms} attempted={attempted} />
      {error && <p className="auth__error" role="alert">{error}</p>}
      {notice && <p className="auth__notice" role="status">{notice}</p>}
      <button className="auth__submit" type="submit" disabled={busy}>Создать аккаунт</button>
    </form>
    <button className="auth__text-button" type="button" onClick={() => { void resend() }} disabled={busy || !email || secondsLeft > 0}>{secondsLeft > 0 ? `Отправить повторно через ${secondsLeft} с` : 'Отправить код повторно'}</button>
    <br /><Link className="auth__text-button" to={`/auth?mode=login&returnTo=${encodeURIComponent(returnTo)}`}>Вернуться ко входу</Link>
  </div></main>
}

export default VerifyEmailPage
