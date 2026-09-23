import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { authPost } from '../../app/auth/auth-context.tsx'
import CodeInput from './code-input.tsx'
import { passwordRequirements, passwordValidationError } from '../../app/auth/password-policy.ts'
import './auth.scss'

function ResetPasswordPage() {
  const location = useLocation()
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '')
  const initialEmail = (location.state as { email?: string } | null)?.email
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(false)
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
    const passwordError = passwordValidationError(password)
    if (passwordError) { setError(passwordError); return }
    if (password !== confirmPassword) { setError('Пароли не совпадают.'); return }
    setBusy(true)
    setError('')
    try {
      await authPost('reset-password', { email, code, password, confirmPassword })
      setDone(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось обновить пароль.')
    } finally { setBusy(false) }
  }

  async function resend() {
    setBusy(true)
    setError('')
    try {
      const result = await authPost<{ message: string }>('forgot-password', { email })
      setNotice(result.message)
      setCooldownUntil(Date.now() + 60_000)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось отправить код.')
    } finally { setBusy(false) }
  }

  return <main className="auth"><div className="auth__panel auth__panel--message">
    <Link className="auth__back" to="/">На главную</Link>
    <Link className="auth__brand" to="/">Staffly</Link>
    <h1>Новый пароль</h1>
    {done ? <p className="auth__notice">Пароль обновлён. Все прежние сеансы завершены.</p> : <>
      <p>Введите код из письма{initialEmail && <> на <strong>{initialEmail}</strong></>} и новый безопасный пароль.</p>
      <form onSubmit={submit}>
        <div className="auth__fields">
          {!initialEmail && <div className="auth__field"><input type="email" aria-label="Электронная почта" placeholder="Электронная почта" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>}
          <CodeInput label="Код из письма" value={code} onChange={setCode} />
          <div className="auth__field"><input type="password" aria-label="Новый пароль" placeholder="Новый пароль" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <div className="auth__password-requirements">{passwordRequirements.map((requirement) => <span className={password && requirement.test(password) ? 'auth__password-rule auth__password-rule--valid' : 'auth__password-rule'} key={requirement.label}>{requirement.label}</span>)}</div>
          <div className="auth__field"><input type="password" aria-label="Повторите пароль" placeholder="Повторите пароль" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div>
        </div>
        {error && <p className="auth__error" role="alert">{error}</p>}
        {notice && <p className="auth__notice" role="status">{notice}</p>}
        <button className="auth__submit" type="submit" disabled={busy}>Сохранить пароль</button>
      </form>
      <button className="auth__text-button" type="button" onClick={() => { void resend() }} disabled={busy || !email || secondsLeft > 0}>{secondsLeft > 0 ? `Отправить повторно через ${secondsLeft} с` : 'Отправить код повторно'}</button>
    </>}
    <br /><Link className="auth__text-button" to="/auth?mode=login">Перейти ко входу</Link>
  </div></main>
}

export default ResetPasswordPage
