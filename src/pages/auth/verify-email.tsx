import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authPost, useAuth } from '../../app/auth/auth-context.tsx'
import CodeInput from './code-input.tsx'
import './auth.scss'

function VerifyEmailPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { verifyEmail } = useAuth()
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '')
  const initialEmail = (location.state as { email?: string } | null)?.email
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
    setBusy(true)
    setError('')
    try {
      await verifyEmail(email, code)
      navigate('/workspace', { replace: true })
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
    <h1>Подтвердите почту</h1>
    <p>Введите код из письма. Он действует 10 минут.{initialEmail && <> Письмо отправлено на <strong>{initialEmail}</strong>.</>}</p>
    <form onSubmit={submit}>
      {!initialEmail && <div className="auth__field"><input type="email" aria-label="Электронная почта" placeholder="Электронная почта" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>}
      <CodeInput label="Код подтверждения" value={code} onChange={setCode} />
      {error && <p className="auth__error" role="alert">{error}</p>}
      {notice && <p className="auth__notice" role="status">{notice}</p>}
      <button className="auth__submit" type="submit" disabled={busy}>Подтвердить</button>
    </form>
    <button className="auth__text-button" type="button" onClick={() => { void resend() }} disabled={busy || !email || secondsLeft > 0}>{secondsLeft > 0 ? `Отправить повторно через ${secondsLeft} с` : 'Отправить код повторно'}</button>
    <br /><Link className="auth__text-button" to="/auth?mode=login">Вернуться ко входу</Link>
  </div></main>
}

export default VerifyEmailPage
