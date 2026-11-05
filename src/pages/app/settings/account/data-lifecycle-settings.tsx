import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import SensitiveCodeInput from '../../../../component/ui/sensitive-code-input.tsx'

type Lifecycle = { cleanupEnabled: boolean; ownedOrganizations: number; policy: { departure: string; account: string; organization: string; archives: string; backupDays: number } }
export default function DataLifecycleSettings() {
  const { apiRequest, logout } = useAuth(), navigate = useNavigate()
  const status = useQuery({ queryKey: ['data-lifecycle'], queryFn: () => apiRequest<Lifecycle>('/profile/data-lifecycle') })
  const [challenge, setChallenge] = useState<{ challengeId: string; expiresAt: string } | null>(null), [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function requestCode() {
    setBusy(true); setError('')
    try { setChallenge(await apiRequest('/profile/delete/request', { method: 'POST', body: { confirm: true } })); setCode('') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось запросить код.') }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!challenge) return
    setBusy(true); setError('')
    try { await apiRequest('/profile/delete/confirm', { method: 'POST', body: { challengeId: challenge.challengeId, code, confirm: true } }); await logout(); navigate('/', { replace: true }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось удалить аккаунт.') }
    finally { setBusy(false) }
  }
  return <section className="settings-card settings-card--danger account-data-lifecycle"><h2>Хранение данных и удаление аккаунта</h2>{status.isPending ? <p>Загружаем условия хранения…</p> : status.isError ? <p role="alert">Не удалось загрузить условия. <button className="app-secondary" onClick={() => void status.refetch()}>Повторить</button></p> : <>
    <p>{status.data.policy.account}</p><p>{status.data.policy.departure}</p><p>{status.data.policy.archives}</p><p>Для резервных копий подготовлен срок {status.data.policy.backupDays} дней. Копии хранятся отдельно от действующей системы.</p>
    {!status.data.cleanupEnabled && <p className="profile-settings-note">Окончательная очистка пока выключена: через 30 дней данные не будут удалены автоматически. Подтверждение сразу закрывает аккаунт и завершает все сеансы.</p>}
    {status.data.ownedOrganizations > 0 ? <p>Перед удалением передайте владение действующими организациями или удалите их.</p> : challenge ? <form onSubmit={event => { event.preventDefault(); void confirm() }}><p>Код отправлен на почту аккаунта и действует 10 минут. Подтверждение закроет аккаунт.</p><SensitiveCodeInput value={code} onChange={setCode} label="Код удаления аккаунта" /><button className="app-danger" disabled={busy || code.length !== 6}>{busy ? 'Подтверждаем…' : 'Подтвердить удаление аккаунта'}</button><button className="app-secondary" type="button" disabled={busy} onClick={() => { setChallenge(null); setCode(''); setError('') }}>Отмена</button></form> : <button className="app-danger" disabled={busy} onClick={() => void requestCode()}>{busy ? 'Отправляем…' : 'Получить код удаления аккаунта'}</button>}
  </>}{error && <p className="form-inline-error" role="alert">{error}</p>}</section>
}
