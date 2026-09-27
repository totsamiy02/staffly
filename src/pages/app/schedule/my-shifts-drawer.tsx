import { useState } from 'react'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { displayDate, formatDuration, formatMonth, moveMonth, shiftState, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useMyWorkTime } from '../../../app/schedule/queries.ts'
import AnimatedOverlay from './animated-overlay.tsx'

type Props = { organization: OrganizationSummary; initialMonth: string; onClose: () => void; onShift: (id: string, month: string) => void }

export default function MyShiftsDrawer({ organization, initialMonth, onClose, onShift }: Props) {
  const [month, setMonth] = useState(initialMonth)
  const [page, setPage] = useState(1)
  const query = useMyWorkTime(organization.id, { from: `${month}-01`, to: `${moveMonth(month, 1)}-01`, page, limit: 20, historyOrder: 'asc' })
  function changeMonth(amount: number) { setMonth(value => moveMonth(value, amount)); setPage(1) }
  const period = query.data?.period
  return <AnimatedOverlay variant="drawer" onClose={onClose}>{close => <aside className="schedule-drawer schedule-drawer--my" role="dialog" aria-modal="true" aria-labelledby="my-shifts-title">
    <header><div><p className="app-eyebrow">Личный график</p><h2 id="my-shifts-title">Мои смены</h2><p>Смены и часы за выбранный месяц</p></div><button type="button" aria-label="Закрыть мои смены" onClick={close}>×</button></header>
    <nav className="my-shifts-period" aria-label="Период моих смен"><button type="button" aria-label="Предыдущий месяц моих смен" onClick={() => changeMonth(-1)}>‹</button><strong>{formatMonth(month)}</strong><button type="button" aria-label="Следующий месяц моих смен" onClick={() => changeMonth(1)}>›</button></nav>
    {query.isLoading ? <div className="schedule-state"><span className="app-spinner" />Загружаем ваши смены…</div> : query.isError ? <div className="schedule-state">Не удалось загрузить ваши смены.<button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : <>
      <section className="my-shifts-summary" aria-label="Часы за выбранный месяц"><div><span>Всего за месяц</span><strong>{formatDuration((period?.workedMinutes ?? 0) + (period?.plannedMinutes ?? 0))}</strong><small>{(period?.workedShifts ?? 0) + (period?.plannedShifts ?? 0)} смен · без отменённых</small></div><div><span>Отработано</span><strong>{formatDuration(period?.workedMinutes ?? 0)}</strong><span>Запланировано</span><strong>{formatDuration(period?.plannedMinutes ?? 0)}</strong></div></section>
      <p className="my-shifts-note">Смены относятся к месяцу их начала.</p>
      <div className="my-shifts-list">{query.data?.history.map(shift => {
        const state = shiftState(shift)
        const date = zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date
        return <button type="button" className={`my-shift-row my-shift-row--${state.key}`} key={shift.id} onClick={() => { onShift(shift.id, month); close() }} aria-label={`${displayDate(date)}, ${state.label}, открыть смену`}>
          <div className="my-shift-row__heading"><strong>{displayDate(date)}</strong><span className={`shift-state-label shift-state-label--${state.key}`}>{state.label}</span></div>
          <div className="my-shift-row__times"><span><small>План</small><strong>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</strong></span><b>{formatDuration(shift.plannedMinutes)}</b></div>
          {shift.actualStartAt && shift.actualEndAt && <div className="my-shift-row__times my-shift-row__times--actual"><span><small>Факт</small><strong>{shiftTimeRange(shift.actualStartAt, shift.actualEndAt, organization.timezone, date)}</strong></span><b>{formatDuration(shift.actualMinutes ?? shift.minutes)}</b></div>}
          {shift.status === 'CANCELLED' && <small className="my-shift-row__break">В часах не учитывается{shift.cancellationReason ? ` · ${shift.cancellationReason}` : ''}</small>}
        </button>
      })}{!query.data?.history.length && <div className="schedule-drawer__empty">В этом месяце у вас нет смен.</div>}</div>
      {query.data && query.data.pagination.pages > 1 && <nav className="shift-history__pagination" aria-label="Страницы моих смен"><button disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>Назад</button><span>{page} из {query.data.pagination.pages}</span><button disabled={page >= query.data.pagination.pages || query.isFetching} onClick={() => setPage(value => value + 1)}>Далее</button></nav>}
    </>}
  </aside>}</AnimatedOverlay>
}
