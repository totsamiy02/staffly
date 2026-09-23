import type { MemberWorkTime } from '../../../app/schedule/types.ts'
import { formatDuration, formatTime } from '../../../app/schedule/date-utils.ts'

const roleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' } as const

export default function WorkTimePanel({ data, onShift, onPage }: { data: MemberWorkTime; onShift?: (id: string) => void; onPage?: (page: number) => void }) {
  const period = data.period
  return <div className="work-time-panel">
    <header><div className="work-time-panel__avatar">{data.member.name.slice(0, 1).toUpperCase()}</div><div><h2>{data.member.name}</h2><p>{roleNames[data.member.role]} · {data.member.active ? 'активный сотрудник' : 'бывший сотрудник'}</p></div></header>
    <div className="work-time-summary"><article><span>Отработано</span><strong>{formatDuration(period?.workedMinutes ?? 0)}</strong></article><article><span>Смен</span><strong>{period?.workedShifts ?? 0}</strong></article><article><span>Средняя смена</span><strong>{period?.workedShifts ? formatDuration(period.averageMinutes) : '—'}</strong></article><article><span>Запланировано</span><strong>{formatDuration(period?.plannedMinutes ?? 0)}</strong><small>{period?.plannedShifts ?? 0} смен</small></article></div>
    <div className="work-time-all"><h3>За всё время в организации</h3><span><strong>{formatDuration(data.allTime?.workedMinutes ?? 0)}</strong> · {data.allTime?.workedShifts ?? 0} смен</span></div>
    <section className="shift-history"><h3>История смен</h3>{data.history.length ? data.history.map((shift) => <button type="button" className="shift-history__row" onClick={() => onShift?.(shift.id)} key={shift.id}><span>{new Intl.DateTimeFormat('ru-RU', { timeZone: data.timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(shift.scheduledStartAt))}</span><strong>{formatTime(shift.actualStartAt ?? shift.scheduledStartAt, data.timezone)}–{formatTime(shift.actualEndAt ?? shift.scheduledEndAt, data.timezone)}</strong><span>{shift.status === 'CANCELLED' ? 'Отменена' : formatDuration(shift.minutes)}</span>{shift.adjusted && <small>Изменено</small>}</button>) : <div className="work-time-empty">За выбранный период смен нет.</div>}{data.pagination.pages > 1 && <div className="shift-history__pagination"><button disabled={data.pagination.page <= 1} onClick={() => onPage?.(data.pagination.page - 1)}>Назад</button><span>{data.pagination.page} из {data.pagination.pages}</span><button disabled={data.pagination.page >= data.pagination.pages} onClick={() => onPage?.(data.pagination.page + 1)}>Далее</button></div>}</section>
  </div>
}
