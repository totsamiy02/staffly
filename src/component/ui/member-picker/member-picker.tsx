import { useState } from 'react'
import Avatar from '../avatar/avatar.tsx'
import './member-picker.scss'

export type PickerMember = { id: string; displayName: string; avatarUrl?: string | null; email?: string; secondary?: string }
export default function MemberPicker({ members, value, onChange, label = 'Сотрудники', disabled = false, loading = false }: { members: PickerMember[]; value: string[]; onChange: (ids: string[]) => void; label?: string; disabled?: boolean; loading?: boolean }) {
  const [search, setSearch] = useState('')
  const terms = search.trim().toLocaleLowerCase().split(/\s+/)
  const shown = members.filter(m => terms.every(term => `${m.displayName} ${m.email ?? ''}`.toLocaleLowerCase().includes(term)))
  return <section className="staffly-member-picker" aria-label={label}><header><strong>{label}<small>{value.length} выбрано</small></strong><div><button type="button" disabled={disabled || loading || !shown.length} onClick={() => onChange([...new Set([...value, ...shown.map(m => m.id)])])}>{search ? 'Все найденные' : 'Выбрать всех'}</button><button type="button" disabled={disabled || !value.length} onClick={() => onChange([])}>Сбросить</button></div></header><input type="search" aria-label={`Поиск: ${label}`} placeholder="Найти сотрудника" value={search} disabled={disabled} onChange={e => setSearch(e.target.value)}/><div className="staffly-member-picker__list">{loading ? <p>Загружаем сотрудников…</p> : shown.length ? shown.map(m => <label className={`staffly-member-picker__person${value.includes(m.id) ? ' is-selected' : ''}`} key={m.id}><Avatar url={m.avatarUrl} name={m.displayName} className="app-avatar"/><span><strong>{m.displayName}</strong>{m.secondary && <small>{m.secondary}</small>}</span><input type="checkbox" checked={value.includes(m.id)} disabled={disabled} onChange={e => onChange(e.target.checked ? [...value, m.id] : value.filter(id => id !== m.id))}/></label>) : <p>{search ? 'Сотрудники не найдены.' : 'В выбранной области нет сотрудников.'}</p>}</div></section>
}
