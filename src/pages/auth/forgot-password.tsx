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
        <h1>Восстановление пароля</h1>
        <p>Укажите почту аккаунта. Мы отправим код для смены пароля.</p>
        <p>Если вы регистрировались через Яндекс и ещё не создавали пароль, войдите через Яндекс. Создать пароль можно в настройках безопасности.</p>
        <form onSubmit={submit}>
          <div className="auth__field"><input type="email" aria-label="Электронная почта" placeholder="Электронная почта" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button className="auth__submit" type="submit" disabled={busy}>Отправить код</button>
        </form>
        <Link className="auth__text-button" to={`/auth?mode=login&returnTo=${encodeURIComponent(returnTo)}`}>Вернуться ко входу</Link>
      </div>
    </main>
  )
}

export default ForgotPasswordPage
