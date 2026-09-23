import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, type AuthUser } from '../../app/auth/auth-context.tsx'
import { passwordRequirements, passwordValidationError } from '../../app/auth/password-policy.ts'
import { formatRussianPhone, isCompleteRussianPhone } from '../../app/profile/phone.ts'
import AppTopbar from './app-topbar.tsx'
import ImageUpload from '../../component/ui/image-upload/image-upload.tsx'
import './app.scss'

function EyeIcon({ visible }: { visible: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" />{!visible && <path d="m3 21 18-18" />}</svg>
}

type PasswordFieldProps = { label: string; value: string; autoComplete: string; onChange: (value: string) => void }
type ActiveSession = { id: string; device: string; browser: string; kind: 'mobile' | 'desktop'; ipAddress: string | null; createdAt: string; lastUsedAt: string; current: boolean }

function PasswordField({ label, value, autoComplete, onChange }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  return <label className="account-password-field"><span>{label}</span><div><input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} data-lpignore="true" data-1p-ignore="true" required /><button type="button" aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setVisible((current) => !current)}><EyeIcon visible={visible} /></button></div></label>
}

const namePattern = /^[\p{L}][\p{L}\p{M}' -]*$/u

function nameError(value: string, label: string) {
  if (!value) return ''
  if (value.length > 80) return `${label}: максимум 80 символов.`
  if (!namePattern.test(value)) return `${label}: используйте буквы, пробел, дефис или апостроф.`
  return ''
}

export default function UserSettingsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user, apiRequest, updateUser, logout } = useAuth()
  const [firstName, setFirstName] = useState(user?.firstName ?? '')
  const [lastName, setLastName] = useState(user?.lastName ?? '')
  const [middleName, setMiddleName] = useState(user?.middleName ?? '')
  const [phone, setPhone] = useState(formatRussianPhone(user?.phone ?? ''))
  const [bio, setBio] = useState(user?.bio ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [message, setMessage] = useState('')
  const [section, setSection] = useState<'profile' | 'security'>('profile')
  const sessions = useQuery({ queryKey: ['auth-sessions'], queryFn: () => apiRequest<{ sessions: ActiveSession[] }>('/auth/sessions'), enabled: section === 'security' })
  const revokeSession = useMutation({ mutationFn: (session: ActiveSession) => apiRequest(`/auth/sessions/${session.id}`, { method: 'DELETE' }), onSuccess: async (_, session) => { if (session.current) { await logout(); navigate('/', { replace: true }) } else await queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }) } })
  const revokeOthers = useMutation({ mutationFn: () => apiRequest('/auth/sessions/revoke-others', { method: 'POST', body: {} }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }) })
  const revokeAll = useMutation({ mutationFn: () => apiRequest('/auth/logout-all', { method: 'POST', body: {} }), onSuccess: async () => { await logout(); navigate('/', { replace: true }) } })

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 5_000)
    return () => window.clearTimeout(timer)
  }, [message])

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setProfileError(''); setMessage('')
    const trimmed = { firstName: firstName.trim(), lastName: lastName.trim(), middleName: middleName.trim(), bio: bio.trim() }
    const invalidName = nameError(trimmed.firstName, 'Имя') || nameError(trimmed.lastName, 'Фамилия') || nameError(trimmed.middleName, 'Отчество')
    if (invalidName) { setProfileError(invalidName); return }
    if (!isCompleteRussianPhone(phone)) { setProfileError('Введите российский номер полностью: +7 (999) 123-45-67.'); return }
    if (trimmed.bio.length > 500) { setProfileError('Описание должно содержать не больше 500 символов.'); return }
    setProfileBusy(true)
    try {
      const result = await apiRequest<{ user: AuthUser }>('/profile', { method: 'PATCH', body: { ...trimmed, phone } })
      updateUser(result.user)
      setFirstName(result.user.firstName ?? ''); setLastName(result.user.lastName ?? ''); setMiddleName(result.user.middleName ?? ''); setPhone(formatRussianPhone(result.user.phone ?? '')); setBio(result.user.bio ?? '')
      setMessage('Профиль сохранён.')
    } catch (failure) { setProfileError(failure instanceof Error ? failure.message : 'Не удалось сохранить профиль.') }
    finally { setProfileBusy(false) }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault(); setPasswordError(''); setMessage('')
    const validationError = passwordValidationError(newPassword)
    if (validationError) { setPasswordError(validationError); return }
    if (newPassword !== confirmPassword) { setPasswordError('Новые пароли не совпадают.'); return }
    if (currentPassword === newPassword) { setPasswordError('Новый пароль должен отличаться от текущего.'); return }
    setPasswordBusy(true)
    try {
      const result = await apiRequest<{ message: string }>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } })
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setMessage(result.message)
    } catch (failure) { setPasswordError(failure instanceof Error ? failure.message : 'Не удалось изменить пароль.') }
    finally { setPasswordBusy(false) }
  }

  const initial = user?.displayName.slice(0, 1).toUpperCase() ?? ''
  const requestedReturn = (location.state as { returnTo?: unknown } | null)?.returnTo
  const returnTo = typeof requestedReturn === 'string' && requestedReturn.startsWith('/app/') && requestedReturn !== '/app/settings' ? requestedReturn : '/app'
  const returnLabel = returnTo.startsWith('/app/organizations/') ? 'Вернуться в организацию' : 'К организациям'
  return <div className="app-page"><AppTopbar /><main className="account-settings-page">
    <Link className="app-back" to={returnTo}>{returnLabel}</Link>
    <header><p className="app-eyebrow">Личный профиль</p><h1>Настройки</h1>{section === 'profile' && <p>Данные профиля видят ваши коллеги в организациях Staffly.</p>}</header>
    <nav className="account-settings-tabs" aria-label="Разделы настроек"><button className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>Профиль</button><button className={section === 'security' ? 'active' : ''} onClick={() => setSection('security')}>Безопасность</button></nav>
    {message && <p className="app-alert" role="status">{message}</p>}

    {section === 'profile' && <section className="profile-editor">
      <aside><ImageUpload endpoint="/profile/avatar" imageUrl={user?.avatarUrl ?? null} name={user?.displayName ?? initial} avatarClassName="account-profile-card__avatar" onChange={(avatarUrl) => { if (user) updateUser({ ...user, avatarUrl }); void queryClient.invalidateQueries({ queryKey: ['organization-members'] }) }} onMessage={setMessage} onError={setProfileError} /><h2>{user?.displayName}</h2><p>{user?.email}</p></aside>
      <form onSubmit={saveProfile} noValidate>
        <div className="account-settings-card__heading"><h2>Личные данные</h2><p>Имя и фамилия будут использоваться в шапке и списке сотрудников.</p></div>
        <div className="profile-fields-grid">
          <label><span>Фамилия</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={80} autoComplete="family-name" placeholder="Иванов" /></label>
          <label><span>Имя</span><input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={80} autoComplete="given-name" placeholder="Ярослав" /></label>
          <label><span>Отчество</span><input value={middleName} onChange={(event) => setMiddleName(event.target.value)} maxLength={80} autoComplete="additional-name" placeholder="Сергеевич" /></label>
          <label><span>Телефон</span><input type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(formatRussianPhone(event.target.value))} maxLength={18} autoComplete="tel" placeholder="+7 (999) 123-45-67" /></label>
          <label className="profile-field--wide"><span>Электронная почта</span><input value={user?.email ?? ''} readOnly aria-readonly="true" /></label>
          <label className="profile-field--wide"><span>О себе</span><textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} rows={4} placeholder="Короткая информация, которую увидят коллеги" /><small>{bio.length}/500</small></label>
        </div>
        {profileError && <p className="form-inline-error" role="alert">{profileError}</p>}
        <button className="app-primary" disabled={profileBusy}>{profileBusy ? 'Сохраняем…' : 'Сохранить профиль'}</button>
      </form>
    </section>}

    {section === 'security' && <><section className="password-editor"><div><p className="app-eyebrow">Безопасность</p><h2>Изменить пароль</h2><p>Введите текущий пароль и придумайте новый. После сохранения остальные сеансы будут завершены, а на почту придёт уведомление.</p></div><form onSubmit={changePassword} autoComplete="off"><PasswordField label="Текущий пароль" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><PasswordField label="Новый пароль" value={newPassword} onChange={setNewPassword} autoComplete="new-password" /><PasswordField label="Повторите новый пароль" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />{newPassword && <div className="password-requirements" aria-label="Требования к паролю">{passwordRequirements.map((requirement) => <span className={requirement.test(newPassword) ? 'password-requirement password-requirement--valid' : 'password-requirement'} key={requirement.label}>{requirement.label}</span>)}</div>}{passwordError && <p className="form-inline-error" role="alert">{passwordError}</p>}<button className="app-primary" disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}>{passwordBusy ? 'Обновляем…' : 'Изменить пароль'}</button></form></section>
      <section className="sessions-editor"><header><div><p className="app-eyebrow">Устройства</p><h2>Активные сеансы</h2><p>Устройства, на которых выполнен вход в ваш аккаунт.</p></div><div><button className="app-secondary" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Выйти везде, кроме этого устройства</button><button className="sessions-editor__danger" disabled={revokeAll.isPending} onClick={() => revokeAll.mutate()}>Завершить все сеансы</button></div></header>{sessions.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем устройства…</div> : sessions.isError ? <div className="app-state">Не удалось загрузить активные сеансы.</div> : <div className="sessions-list">{sessions.data?.sessions.map((session) => <article key={session.id}><span className={`session-device-icon session-device-icon--${session.kind}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x={session.kind === 'mobile' ? '7' : '3'} y={session.kind === 'mobile' ? '2' : '4'} width={session.kind === 'mobile' ? '10' : '18'} height={session.kind === 'mobile' ? '20' : '13'} rx="2" />{session.kind === 'desktop' && <path d="M8 21h8M12 17v4" />}</svg></span><div><strong>{session.device} · {session.browser}</strong><span className={session.current ? 'session-current' : ''}><i />{session.current ? 'Это устройство · активно сейчас' : `Последняя активность ${new Date(session.lastUsedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`}</span><small>{session.ipAddress ? `IP: ${session.ipAddress}` : 'IP не определён'} · вход {new Date(session.createdAt).toLocaleDateString('ru-RU')}</small></div><button disabled={revokeSession.isPending} onClick={() => revokeSession.mutate(session)}>{session.current ? 'Выйти' : 'Отключить'}</button></article>)}</div>}</section></>}
  </main></div>
}
