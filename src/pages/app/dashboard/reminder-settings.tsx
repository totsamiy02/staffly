import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useEmailPreferences, type EmailSettings } from '../../../app/notifications/email-preferences-query.ts';
import type { EmailCategory } from '../../../app/notifications/email-preferences.ts';
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx';
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx';
import './attention-panel.scss';

export default function ReminderSettings({ onClose }: { onClose: () => void }) {
  return <AnimatedOverlay variant="modal" onClose={onClose}>{close => <ReminderDialog onClose={close} />}</AnimatedOverlay>;
}
function ReminderDialog({ onClose }: { onClose: () => void }) {
  const { query, mutation } = useEmailPreferences(onClose);
  return <DocumentDialog title="Напоминания" eyebrow="Уведомления" className="attention-settings" busy={mutation.isPending} onClose={onClose} description="На сайте напоминания приходят автоматически. Выберите, что дополнительно получать на почту.">
    {query.isPending ? <p role="status">Загружаем настройки…</p> : query.isError || !query.data ? <div role="alert"><p>Не удалось загрузить настройки.</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div>
      : <ReminderForm key={query.data.revision} settings={query.data} busy={mutation.isPending} onClose={onClose} onSave={categories => mutation.mutate({ categories })} />}
  </DocumentDialog>;
}
function ReminderForm({ settings, busy, onClose, onSave }: { settings: EmailSettings; busy: boolean; onClose: () => void; onSave: (categories: Partial<Record<EmailCategory, boolean>>) => void }) {
  const [categories, setCategories] = useState<Partial<Record<EmailCategory, boolean>>>({ actionDigest: settings.categories.actionDigest, documents: settings.categories.documents });
  return <form onSubmit={e => { e.preventDefault(); onSave(Object.fromEntries(Object.entries(categories).filter(([key]) => settings.availableCategories.includes(key as EmailCategory)))); }}>
    {!settings.enabled && <p className="attention-settings__notice">Рабочие письма отключены. Включить их можно в <Link to="/app/settings?section=notifications" onClick={onClose}>настройках аккаунта</Link>.</p>}
    <div className="attention-settings__choices">{([{ key: 'actionDigest', title: 'Заявки и задачи', text: 'Новые действия, согласования и напоминания по срокам' }, { key: 'documents', title: 'Ознакомления с документами', text: 'Назначение документа и напоминания по срокам' }] as const).filter(item => settings.availableCategories.includes(item.key)).map(item => <label key={item.key}><span><strong>{item.title}</strong><small>{item.text}</small></span><input type="checkbox" checked={categories[item.key]} disabled={busy || !settings.enabled} onChange={e => setCategories(previous => ({ ...previous, [item.key]: e.target.checked }))} /></label>)}</div>
    <p className="attention-settings__caption">Один раз за день до срока и один раз при просрочке. После выполнения напоминания прекращаются. Настройки общие для всех ваших организаций.</p>
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy || !settings.enabled}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></footer>
  </form>;
}
