import AsyncPanel from '../../../component/ui/async-panel.tsx'
import { accountedTimeLabel } from '../../../app/schedule/time-correction.ts'
import TimeCorrectionAction from './time-correction-action.tsx'
import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import MemberProfileLink from '../../../component/ui/member-profile-link.tsx'
import RoleBadge from '../../../component/ui/role-badge/role-badge.tsx'
import type { MemberWorkTime } from '../../../app/schedule/types.ts'
import { formatDuration } from '../../../app/schedule/date-utils.ts'


export default function WorkTimePanel({ data, onShift, onPage, historyPending = false }: { data: MemberWorkTime; historyPending?: boolean; onShift?: (id: string) => void; onPage?: (page: number) => void }) {
  const period = data.period
  return <div className="work-time-panel">
    <header><MemberAvatar memberId={data.member.id} url={data.member.avatarUrl} name={data.member.name} className="work-time-panel__avatar" /><div><h2><MemberProfileLink memberId={data.member.id}>{data.member.name}</MemberProfileLink></h2><p><RoleBadge role={data.member.role} /> · {data.member.active ? 'активный сотрудник' : 'бывший сотрудник'}</p></div></header>
    <div className="work-time-summary"><article><span>Отработано</span><strong>{formatDuration(period?.workedMinutes ?? 0)}</strong></article><article><span>Смен</span><strong>{period?.workedShifts ?? 0}</strong></article><article><span>Запланировано</span><strong>{formatDuration(period?.plannedMinutes ?? 0)}</strong><small>{period?.plannedShifts ?? 0} смен</small></article></div>
    <div className="work-time-all"><h3>За всё время в организации</h3><span><strong>{formatDuration(data.allTime?.workedMinutes ?? 0)}</strong> · {data.allTime?.workedShifts ?? 0} смен</span></div>
    <section className="shift-history"><h3>История смен</h3><AsyncPanel pending={historyPending} identity={String(data.pagination.page)} minHeight={220}>{data.history.length ? data.history.map((shift) => <div className="shift-history__item" key={shift.id}><button type="button" className="shift-history__row" onClick={() => onShift?.(shift.id)} disabled={!onShift}><span>{new Intl.DateTimeFormat('ru-RU', { timeZone: data.timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(shift.scheduledStartAt))}</span><strong>{accountedTimeLabel(shift, data.timezone)}</strong><span>{shift.status === 'CANCELLED' ? 'Отменена' : formatDuration(shift.minutes)}</span>{shift.adjusted && <small>Изменено</small>}</button><TimeCorrectionAction shift={shift} /></div>) : <div className="work-time-empty">За выбранный период смен нет.</div>}{data.pagination.pages > 1 && <div className="shift-history__pagination"><button disabled={data.pagination.page <= 1} onClick={() => onPage?.(data.pagination.page - 1)}>Назад</button><span>{data.pagination.page} из {data.pagination.pages}</span><button disabled={data.pagination.page >= data.pagination.pages} onClick={() => onPage?.(data.pagination.page + 1)}>Далее</button></div>}</AsyncPanel></section>
  </div>
}
