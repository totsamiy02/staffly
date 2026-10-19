import { useState } from 'react'
import type { RequestType } from '../../../../app/requests/types.ts'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import RequestIcon from '../request-icon.tsx'

const groups = [
  { id: 'absence', label: 'Отсутствия' },
  { id: 'schedule', label: 'Смены и подмены' },
  { id: 'other', label: 'Другие обращения' },
  { id: 'custom', label: 'Свои типы' },
] as const
function category(type: RequestType) {
  if (!type.systemCode) return 'custom'
  if (['VACATION', 'DAY_OFF', 'SICK_LEAVE', 'SICK', 'ABSENCE'].includes(type.systemCode)) return 'absence'
  if (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode)) return 'schedule'
  return 'other'
}

export default function RequestTypeChooser({ types, loading, error, retry, onSelect, onClose }: { types: RequestType[]; loading: boolean; error: boolean; retry: () => unknown; onSelect: (type: RequestType) => void; onClose: () => void }) {
  const [search, setSearch] = useState(''), [group, setGroup] = useState('all')
  const availableGroups = groups.filter(g => types.some(type => category(type) === g.id))
  const shown = types.filter(type => (group === 'all' || category(type) === group) && `${type.name} ${type.description ?? ''}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  return <DocumentDialog className="request-type-choice-dialog" title="Выбор типа заявки" eyebrow="Заявки" onClose={onClose}>
    <div className="request-type-choice-tools"><label><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input type="search" aria-label="Поиск типа заявки" placeholder="Найти тип заявки" value={search} onChange={event => setSearch(event.target.value)} /></label><nav aria-label="Категории типов заявок"><button aria-pressed={group === 'all'} onClick={() => setGroup('all')}>Все</button>{availableGroups.map(item => <button key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</nav></div>
    <div className="request-type-choice-body">{loading ? <p className="app-state">Загружаем типы…</p> : error ? <div className="app-state"><p>Не удалось загрузить типы заявок.</p><button className="app-secondary" onClick={() => void retry()}>Повторить</button></div> : <>{availableGroups.map(item => {
      const items = shown.filter(type => category(type) === item.id)
      return items.length > 0 && <section className="request-type-choice-group" key={item.id}><h3>{item.label}<span>{items.length}</span></h3><div className="request-type-choice-list">{items.map(type => <button key={type.id} onClick={() => onSelect(type)}><span className="request-type-choice-icon"><RequestIcon code={type.systemCode} /></span><span><strong>{type.name}</strong><small title={type.description ?? undefined}>{type.description ?? 'Обращение сотрудника'}</small></span></button>)}</div></section>
    })}{!shown.length && <p className="app-state">{types.length ? 'По запросу ничего не найдено.' : 'Доступных типов заявок пока нет.'}</p>}</>}</div>
  </DocumentDialog>
}
