import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { authPost, useAuth } from '../../app/auth/auth-context.tsx'
import './auth.scss'

type Mode = 'login' | 'register'
type Field = 'email' | 'password' | 'confirm'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function FieldIcon({ kind }: { kind: 'email' | 'password' }) {
  return kind === 'email' ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </svg>
  )
}

function EyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {!visible && <path d="m3 21 18-18" />}
    </svg>
  )
}

function AuthPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode: Mode = searchParams.get('mode') === 'register' ? 'register' : 'login'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [consentData, setConsentData] = useState(false)
  const [consentTerms, setConsentTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState('')
  const [notice, setNotice] = useState('')
  const [visible, setVisible] = useState<Record<'password' | 'confirm', boolean>>({ password: false, confirm: false })
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [attempted, setAttempted] = useState(false)

  const emailError = !email.trim() ? 'Укажите электронную почту.' : !emailPattern.test(email.trim()) ? 'Введите корректный адрес почты.' : ''
  const passwordError = !password ? 'Укажите пароль.' : mode === 'register' && (password.length < 10 || password.length > 128)
    ? 'Пароль должен содержать от 10 до 128 символов.' : ''
  const confirmError = !confirm ? 'Повторите пароль.' : confirm !== password ? 'Пароли не совпадают.' : ''

  function switchMode(next: Mode) {
    setSearchParams({ mode: next })
    setAttempted(false)
    setTouched({})
    setServerError('')
    setNotice('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (emailError || passwordError || (mode === 'register' && (confirmError || !consentData || !consentTerms))) return
    setSubmitting(true)
    setServerError('')
    setNotice('')
    try {
      if (mode === 'register') {
        await authPost('register', { email, password, confirmPassword: confirm, consentData, consentTerms })
        navigate('/verify-email', { state: { email: email.trim().toLowerCase(), cooldownUntil: Date.now() + 60_000 } })
      } else {
        await login(email, password)
        navigate('/workspace', { replace: true })
      }
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Не удалось выполнить запрос.')
    } finally {
      setSubmitting(false)
    }
  }

  async function resendVerification() {
    setSubmitting(true)
    try {
      const result = await authPost<{ message: string }>('resend-verification', { email })
      setNotice(result.message)
      setServerError('')
    } catch (error) {
      setServerError(error instanceof Error ? error.message : 'Не удалось выполнить запрос.')
    } finally {
      setSubmitting(false)
    }
  }

  function input(name: Field, placeholder: string, value: string, setValue: (value: string) => void, error: string) {
    const isPassword = name !== 'email'
    const showError = (attempted || touched[name]) && error
    return (
      <div className="auth__field-group">
        <div className={`auth__field${showError ? ' auth__field--invalid' : ''}`}>
          <FieldIcon kind={isPassword ? 'password' : 'email'} />
          <input
            aria-label={placeholder}
            aria-invalid={Boolean(showError)}
            aria-describedby={showError ? `${name}-error` : undefined}
            autoComplete={isPassword ? 'off' : 'email'}
            data-lpignore={isPassword ? 'true' : undefined}
            data-1p-ignore={isPassword ? 'true' : undefined}
            spellCheck={false}
            type={isPassword ? visible[name] ? 'text' : 'password' : 'email'}
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, [name]: true }))}
          />
          {isPassword && (
            <button type="button" className="auth__eye" aria-label={visible[name] ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setVisible((current) => ({ ...current, [name]: !current[name] }))}>
              <EyeIcon visible={visible[name]} />
            </button>
          )}
        </div>
        {showError && <p className="auth__error" id={`${name}-error`}>{error}</p>}
      </div>
    )
  }

  return (
    <main className="auth">
      <div className="auth__panel">
        <Link className="auth__back" to="/" aria-label="На главную"><span>На главную</span></Link>
        <a className="auth__brand" href="/">Staffly</a>
        <p className="auth__tagline">Управление командой становится проще</p>

        <div className="auth__tabs" role="group" aria-label="Выберите действие">
          <button type="button" className={mode === 'login' ? 'auth__tab auth__tab--active' : 'auth__tab'} aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>Вход</button>
          <button type="button" className={mode === 'register' ? 'auth__tab auth__tab--active' : 'auth__tab'} aria-pressed={mode === 'register'} onClick={() => switchMode('register')}>Регистрация</button>
        </div>

        <div className="auth__content">
          <h1>{mode === 'login' ? 'С возвращением!' : 'Создайте аккаунт'}</h1>
          <p className="auth__intro">{mode === 'login' ? 'Войдите в свой аккаунт, чтобы продолжить' : 'Начните использовать Staffly уже сегодня'}</p>

          <form noValidate autoComplete="off" onSubmit={submit}>
            <div className="auth__fields">
              {input('email', 'Электронная почта', email, setEmail, emailError)}
              {input('password', 'Пароль', password, setPassword, passwordError)}
              {mode === 'register' && input('confirm', 'Повторите пароль', confirm, setConfirm, confirmError)}
            </div>

            {mode === 'login' ? (
              <div className="auth__options">
                <button type="button" className="auth__forgot" onClick={() => navigate('/forgot-password')}>Забыли пароль?</button>
              </div>
            ) : (
              <div className="auth__consents">
                <label className="auth__check">
                  <input type="checkbox" checked={consentData} onChange={(event) => setConsentData(event.target.checked)} />
                  <span>Я согласен(на) с <a href="/personal-data-consent" target="_blank" rel="noopener noreferrer">обработкой персональных данных</a></span>
                </label>
                {attempted && !consentData && <p className="auth__error">Необходимо согласие на обработку данных.</p>}
                <label className="auth__check">
                  <input type="checkbox" checked={consentTerms} onChange={(event) => setConsentTerms(event.target.checked)} />
                  <span>Я ознакомлен(на) с <a href="/terms" target="_blank" rel="noopener noreferrer">Пользовательским соглашением</a></span>
                </label>
                {attempted && !consentTerms && <p className="auth__error">Подтвердите ознакомление с соглашением.</p>}
              </div>
            )}

            {serverError && <p className="auth__error" role="alert">{serverError}</p>}
            {serverError.includes('Подтвердите email') && <><button className="auth__text-button" type="button" onClick={() => { void resendVerification() }} disabled={submitting}>Отправить код повторно</button><br /><Link className="auth__text-button" to="/verify-email" state={{ email: email.trim().toLowerCase() }}>Ввести код</Link></>}
            {notice && <p className="auth__notice" role="status">{notice}</p>}
            <button className="auth__submit" type="submit" disabled={submitting}>{submitting ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
          </form>
        </div>

        <p className="auth__closing">Вместе к эффективной команде</p>
      </div>
    </main>
  )
}

export default AuthPage
