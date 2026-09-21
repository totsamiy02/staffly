import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import './auth.scss'

type Mode = 'login' | 'register'
type Field = 'email' | 'password' | 'confirm'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])\S{8,24}$/

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
  const [searchParams, setSearchParams] = useSearchParams()
  const mode: Mode = searchParams.get('mode') === 'register' ? 'register' : 'login'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [consentData, setConsentData] = useState(false)
  const [consentTerms, setConsentTerms] = useState(false)
  const [remember, setRemember] = useState(false)
  const [visible, setVisible] = useState<Record<'password' | 'confirm', boolean>>({ password: false, confirm: false })
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [attempted, setAttempted] = useState(false)

  const emailError = !email.trim() ? 'Укажите электронную почту.' : !emailPattern.test(email.trim()) ? 'Введите корректный адрес почты.' : ''
  const passwordError = !password ? 'Укажите пароль.' : mode === 'register' && !passwordPattern.test(password)
    ? 'От 8 до 24 символов: заглавная и строчная буквы, цифра и специальный символ.'
    : mode === 'login' && (password.length < 8 || password.length > 24) ? 'Пароль должен содержать от 8 до 24 символов.' : ''
  const confirmError = !confirm ? 'Повторите пароль.' : confirm !== password ? 'Пароли не совпадают.' : ''

  function switchMode(next: Mode) {
    setSearchParams({ mode: next })
    setAttempted(false)
    setTouched({})
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (emailError || passwordError || (mode === 'register' && (confirmError || !consentData || !consentTerms))) return
    navigate('/')
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
                <label className="auth__check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Запомнить меня</span></label>
                <button type="button" className="auth__forgot">Забыли пароль?</button>
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

            <button className="auth__submit" type="submit">{mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
          </form>
        </div>

        <p className="auth__closing">Вместе к эффективной команде</p>
      </div>
    </main>
  )
}

export default AuthPage
