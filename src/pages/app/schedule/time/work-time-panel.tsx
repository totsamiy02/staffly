import './work-time-panel.scss';
import AsyncPanel from '../../../../component/ui/async-panel.tsx';
import TimeCorrectionAction from './time-correction-action.tsx';
import MemberAvatar from '../../../../component/ui/member-avatar.tsx';
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx';
import RoleBadge from '../../../../component/ui/role-badge/role-badge.tsx';
import type { MemberWorkTime } from '../../../../app/schedule/types.ts';
import { formatDuration, confirmedDuration } from '../../../../app/schedule/date-utils.ts';
import { calculateWorkTime, workTimeStateNames, workTimeSourceNames } from '../../../../shared/work-time.ts';
import { WorkTimeTotals, WorkTimeRulesButton } from './work-time-totals.tsx';

export default function WorkTimePanel({ data, onShift, onPage, historyPending = false }: {
  data: MemberWorkTime; historyPending?: boolean; onShift?: (id: string) => void; onPage?: (page: number) => void;
}) {
  const period = data.period;
  return <div className="work-time-panel">
    <header><MemberAvatar memberId={data.member.id} url={data.member.avatarUrl} name={data.member.name} className="work-time-panel__avatar" /><div><h2><MemberProfileLink memberId={data.member.id}>{data.member.name}</MemberProfileLink></h2><p><RoleBadge role={data.member.role} /> · {data.member.active ? 'активный сотрудник' : 'бывший сотрудник'}</p></div></header>
    <WorkTimeTotals metrics={period} />
    {!!period?.pendingShifts && <p className="work-time-attention">Без подтверждения после окончания: {period.pendingShifts} смен. Предварительные часы показаны отдельно.</p>}
    <div className="work-time-all"><h3>За всё время в организации</h3><span>Подтверждено: <strong>{confirmedDuration(data.allTime?.workedMinutes ?? 0, data.allTime?.confirmedShifts ?? 0)}</strong> · предварительно {formatDuration(data.allTime?.estimatedMinutes ?? 0)}</span></div>
    <section className="shift-history accounting-shift-history">
      <header><h3>История смен</h3><WorkTimeRulesButton /></header>
      <AsyncPanel pending={historyPending} identity={String(data.pagination.page)} minHeight={220}>
        {data.history.length ? data.history.map(shift => {
          const time = shift.accounting ?? calculateWorkTime(shift);
          const timezone = shift.timezone ?? data.timezone;
          return <article className="accounting-history-row" key={shift.id}>
            <button type="button" className="accounting-history-summary" onClick={() => onShift?.(shift.id)} disabled={!onShift}>
              <span className="accounting-history-date"><strong>{new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(shift.scheduledStartAt))}</strong><small>{workTimeSourceNames[time.source]}</small></span>
              <span><small>План</small><strong>{formatDuration(time.plannedMinutes)}</strong></span>
              <span><small>Предварительно</small><strong>{time.state === 'CANCELLED' ? '—' : formatDuration(time.estimatedMinutes)}</strong></span>
              <span><small>Подтверждено</small><strong>{time.confirmedMinutes === null ? '—' : formatDuration(time.confirmedMinutes)}</strong></span>
            </button>
            <footer><span className="work-time-state">{workTimeStateNames[time.state]}</span>{shift.adjusted && <small>Есть изменения</small>}<TimeCorrectionAction shift={shift} locationId={shift.locationId} /></footer>
          </article>;
        }) : <div className="work-time-empty">За выбранный период смен нет.</div>}
        {data.pagination.pages > 1 && <div className="shift-history__pagination"><button disabled={data.pagination.page <= 1} onClick={() => onPage?.(data.pagination.page - 1)}>Назад</button><span>{data.pagination.page} из {data.pagination.pages}</span><button disabled={data.pagination.page >= data.pagination.pages} onClick={() => onPage?.(data.pagination.page + 1)}>Далее</button></div>}
      </AsyncPanel>
    </section>
  </div>;
}
