import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { emailCategories, type EmailCategory, type EmailPreferences } from '../../app/notifications/email-preferences.ts'
import ModuleIcon from '../../component/ui/module-icon.tsx'
import AsyncPanel from '../../component/ui/async-panel.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import './email-notification-settings.scss'

type Settings = EmailPreferences & { availableCategories: EmailCategory[] }
type Change = { enabled?: boolean; categories?: Partial<Record<EmailCategory, boolean>>; confirmDisable?: boolean }
function MailIcon({ lock = false }: { lock?: boolean }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{lock ? <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></> : <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>}</svg> }
function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return <button className="email-switch" type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}><span /></button>
}
const groups = [{ key: 'schedule', title: 'Расписание', description: 'Ваши смены, предложения и обсуждение графика', icon: 'schedule' }, { key: 'requests', title: 'Заявки и отпуск', description: 'Решения и сбор пожеланий', icon: 'requests' }, { key: 'documents', title: 'Документы', description: 'Ознакомление с назначенными документами', icon: 'documents' }, { key: 'events', title: 'События', description: 'Важные встречи и изменения планов', icon: 'events' }, { key: 'management', title: 'Для руководителей', description: 'Только в пределах вашего доступа', icon: 'employees' }]

export default function EmailNotificationSettings() {
  const { user, apiRequest } = useAuth(), cache = useQueryClient()
  const toast = useToast()
  const key = ['email-preferences', user?.id]
  const query = useQuery({ queryKey: key, queryFn: () => apiRequest<Settings>('/profile/email-preferences'), enabled: !!user, staleTime: 60_000 })
  const [confirm, setConfirm] = useState(false)
  const mutation = useMutation({ mutationFn: (change: Change) => apiRequest<Settings>('/profile/email-preferences', { method: 'PATCH', body: { ...change, revision: cache.getQueryData<Settings>(key)?.revision ?? 0 } }), onSuccess: (settings, change) => { cache.setQueryData(key, settings); setConfirm(false); toast(change.enabled === true ? 'Рабочие письма включены. Ваш выбор категорий сохранён.' : change.enabled === false ? 'Рабочие письма отключены.' : 'Настройки уведомлений сохранены.', 'success') }, onError: (error) => { toast(error instanceof Error ? error.message : 'Не удалось сохранить настройки уведомлений.', 'error'); void query.refetch() } })
  const settings = query.data, busy = mutation.isPending
  return <div className="email-settings">
    <header className="email-settings__intro"><span className="email-settings__mail"><MailIcon /></span><div><h2>Уведомления на почту</h2><p>Дополнительный канал. Все уведомления доступны на сайте.</p></div></header>
    <div className="email-settings__recipient"><div><small>Адрес вашей учётной записи</small><strong>{user?.email}</strong></div><p>Единые настройки для всех ваших организаций</p></div>
    <AsyncPanel pending={query.isPending} minHeight={300} label="Загружаем настройки уведомлений">
      {query.isError && !settings ? <div className="email-settings__feedback is-error" role="alert"><p>Не удалось загрузить настройки.</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : settings && <>
        <section className="email-settings__master"><div><h3>Рабочие уведомления на почту</h3><p>Выберите, какие письма получать</p></div><Switch checked={settings.enabled} disabled={busy} label="Рабочие уведомления на почту" onChange={() => settings.enabled ? setConfirm(true) : mutation.mutate({ enabled: true })} /></section>
        {!settings.enabled && <div className="email-settings__notice"><MailIcon /><div><strong>Рабочие письма отключены</strong><p>Включите рассылку, чтобы получать выбранные уведомления. Ваш выбор категорий сохранится. Пропущенные письма не отправятся задним числом.</p></div></div>}
        <div className="email-settings__groups">{groups.map(group => {
          const categories = emailCategories.filter(item => item.group === group.key && settings.availableCategories.includes(item.key))
          if (!categories.length) return null
          return <section className="email-settings__group" key={group.key}><header><span><ModuleIcon section={group.icon} /></span><div><h3>{group.title}</h3><p>{group.description}</p></div></header><div>{categories.map(item => <div className="email-settings__row" key={item.key}><span className="email-settings__row-icon"><ModuleIcon section={item.icon} /></span><div><label id={`email-${item.key}`}>{item.title}</label><p>{item.description}</p></div><Switch label={item.title} checked={settings.categories[item.key]} disabled={!settings.enabled || busy} onChange={() => mutation.mutate({ categories: { [item.key]: !settings.categories[item.key] } })} /></div>)}</div></section>
        })}</div>
      </>}
    </AsyncPanel>
    <div className="email-settings__mandatory"><MailIcon lock /><p>Письма о безопасности аккаунта, коды подтверждения и подтверждения критических действий отправляются всегда.</p></div>
    {busy && <p className="email-settings__saving" role="status"><span className="app-spinner" /> Сохраняем…</p>}
    {mutation.isError && <div className="email-settings__feedback is-error"><p>{mutation.error instanceof Error ? mutation.error.message : 'Не удалось сохранить настройки. Прежние настройки сохранены.'}</p><button className="app-secondary" onClick={() => mutation.variables && mutation.mutate(mutation.variables)}>Повторить</button></div>}
    {confirm && <AnimatedOverlay variant="modal" dismissible={!busy} className="email-settings__overlay" onClose={() => { if (!busy) setConfirm(false) }}>{() => <DocumentDialog eyebrow="Уведомления на почту" title="Отключить рабочие письма?" className="email-settings__dialog" busy={busy} onClose={() => setConfirm(false)} onEscape={() => { if (!busy) setConfirm(false) }}><div className="email-settings__confirmation"><span className="email-settings__mail"><MailIcon /></span><p>Вы перестанете получать на почту изменения смен и другие рабочие уведомления. Все уведомления останутся на сайте.</p><p>Письма о безопасности и коды подтверждения продолжат приходить.</p><small>Выбранные категории сохранятся. Рассылку можно включить снова в любой момент.</small>{mutation.isError && <p role="alert" className="form-inline-error">Не удалось отключить письма. Повторите попытку.</p>}</div><footer><button className="app-secondary" disabled={busy} onClick={() => setConfirm(false)}>Оставить включёнными</button><button className="app-primary" disabled={busy} onClick={() => mutation.mutate({ enabled: false, confirmDisable: true })}>{busy ? 'Отключаем…' : 'Отключить письма'}</button></footer></DocumentDialog>}</AnimatedOverlay>}
  </div>
}
