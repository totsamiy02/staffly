import { useState } from 'react'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import Select from '../../../component/ui/select/select.tsx'
import { useOrganizationMembers } from '../../../app/organizations/queries.ts'
import { useCancelledShifts } from '../../../app/schedule/queries.ts'
import { displayDate, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import EmployeePicker from './employee-picker.tsx'

export default function ScheduleHistory({ organization, onShift }: { organization: OrganizationSummary; onShift: (shift: WorkShift) => void }) {
  const [memberId, setMemberId] = useState('')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const members = useOrganizationMembers(organization.id)
  const history = useCancelledShifts(organization.id, { page, order, memberId })
  return <div className="schedule-history">
    <div className="schedule-history-filters"><EmployeePicker members={members.data?.members ?? []} value={memberId} required={false} emptyLabel="Все сотрудники" onChange={id => { setMemberId(id); setPage(1) }} /><label><span>Порядок отмены</span><Select value={order} onChange={event => { setOrder(event.target.value as 'asc' | 'desc'); setPage(1) }}><option value="desc">Сначала новые отмены</option><option value="asc">Сначала старые отмены</option></Select></label></div>
    {history.isLoading ? <div className="schedule-state">Загружаем историю…</div> : history.isError ? <div className="schedule-state"><p>Не удалось загрузить историю.</p><button className="app-secondary" onClick={() => void history.refetch()}>Повторить</button></div> : <>
      <p className="schedule-history-count">Отменённых смен: {history.data?.pagination.total ?? 0} · за всё время</p>
      <div className="schedule-history-list">{history.data?.shifts.map(shift => <button key={shift.id} onClick={() => onShift(shift)}><Avatar url={shift.memberAvatarUrl} name={shift.memberName} className="app-avatar" /><span className="schedule-history-person"><strong>{shift.memberName}</strong><small>{shift.positionName ?? 'Без должности'}</small></span><span className="schedule-history-date"><strong>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)}</strong><small>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</small></span><span className="schedule-history-reason"><strong>{shift.cancellationReason ?? 'Причина не указана'}</strong><small>{shift.cancelledAt ? `Отменена ${new Date(shift.cancelledAt).toLocaleString('ru-RU', { timeZone: organization.timezone })}` : 'Отменена'}</small></span><span aria-hidden="true">›</span></button>)}</div>
      {!history.data?.shifts.length && <div className="schedule-empty">Отменённых смен по выбранным условиям нет.</div>}
      {!!history.data && history.data.pagination.pages > 1 && <nav className="members-pagination" aria-label="Страницы истории смен"><button className="app-secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Назад</button><span>{page} / {history.data.pagination.pages}</span><button className="app-secondary" disabled={page >= history.data.pagination.pages} onClick={() => setPage(value => value + 1)}>Далее</button></nav>}
    </>}
  </div>
}
