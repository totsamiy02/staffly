import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { authPost } from '../../app/auth/auth-context.tsx'
import { safeReturnTo } from '../../app/auth/return-to.ts'
import './auth.scss'

function ForgotPasswordPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo)
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await authPost('forgot-password', { email })
      navigate('/reset-password', { state: { email: email.trim().toLowerCase(), cooldownUntil: Date.now() + 60_000, returnTo } })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось выполнить запрос.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="auth__panel auth__panel--message">
        <Link className="auth__back" to="/">На главную</Link>
        <Link className="auth__brand" to="/">Staffly</Link>
        <h1>Восстановление доступа</h1>
        <p>Укажите текущую почту аккаунта Staffly. Код из письма позволит задать новый пароль.</p>
        <p>Это работает и после регистрации через Яндекс, даже если пароля ещё нет. Если вы потеряли доступ и к Яндексу, и к этой почте, сначала восстановите доступ к почтовому ящику.</p>
        <form onSubmit={submit}>
          <div className="auth__field"><input type="email" name="email" autoComplete="email" aria-label="Электронная почта" placeholder="Электронная почта" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button className="auth__submit" type="submit" disabled={busy}>Отправить код</button>
        </form>
        <Link className="auth__text-button" to={`/auth?mode=login&returnTo=${encodeURIComponent(returnTo)}`}>Вернуться ко входу</Link>
      </div>
    </main>
  )
}

export default ForgotPasswordPage
