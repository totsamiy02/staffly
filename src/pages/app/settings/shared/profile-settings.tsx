import type { ReactNode } from 'react'
import { AccessIcon } from '../access/access-elements.tsx'
import './profile-settings.scss'

type DetailItem = { label: string; value: ReactNode; wide?: boolean }

export function ProfileDetails({ items, title, icon = 'info', columns = 2, prose = false }: { items: DetailItem[]; title?: string; icon?: string; columns?: 1 | 2 | 3; prose?: boolean }) {
  const details = <dl className={`profile-details profile-details--${columns}${prose ? ' profile-details--prose' : ''}`}>{items.map(({ label, value, wide }) => <div key={label} className={wide ? 'profile-details__wide' : undefined}><dt>{label}</dt><dd>{value || <span className="profile-details__empty">Не указано</span>}</dd></div>)}</dl>
  return title ? <section className="profile-details-section" aria-label={title}><header><AccessIcon name={icon} /><h3>{title}</h3></header>{details}</section> : details
}

export function ProfileEditActions({ editing, busy = false, onEdit, onCancel }: { editing: boolean; busy?: boolean; onEdit: () => void; onCancel: () => void }) {
  return <div className="profile-edit-actions">{editing ? <><button className="app-secondary" type="button" disabled={busy} onClick={onCancel}>Отмена</button><button className="app-primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></> : <button className="app-secondary" type="button" onClick={onEdit}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" /></svg>Редактировать</button>}</div>
}
