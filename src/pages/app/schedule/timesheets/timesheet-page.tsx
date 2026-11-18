import { WorkTimeRulesButton } from '../time/work-time-totals.tsx';
import { workTimeStateNames } from '../../../../shared/work-time.ts';
import TimesheetDisclosure, { TimesheetFileIcon } from './timesheet-disclosure.tsx';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../../app/auth/auth-context.tsx';
import { canAccess } from '../../../../app/access/catalog.ts';
import { useTimesheet } from '../../../../app/schedule/timesheets/queries.ts';
import { absenceNames, attendanceNames } from '../../../../app/schedule/timesheets/types.ts';
import { useSubscription } from '../../../../app/subscriptions/context.ts';
import { monthKeyInZone, moveMonth, formatDuration, confirmedDuration } from '../../../../app/schedule/date-utils.ts';
import { invalidateOrganizationWork } from '../../../../app/live-query.ts';
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts';
import { useTimeCorrection } from '../../../../app/schedule/time/time-correction-context.tsx';
import type { OrganizationSummary } from '../../../../app/organizations/types.ts';
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx';
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx';
import RequestErrorMessage, { RequestErrorState } from '../../../../component/ui/request-error-message.tsx';
import OperationStatus, { type OperationState } from '../../../../component/ui/operation-status.tsx';
import ScheduleSectionHeader from '../shared/schedule-section-header.tsx';
import TimesheetReports from './timesheet-reports.tsx';
import './timesheet.scss';
const statuses: Record<string, string> = { OPEN: 'Сверка', CLOSED: 'Зафиксирован' };
const eventNames: Record<string, string> = { SUBMIT: 'Передан на проверку', RETURN: 'Возвращён в работу', CLOSE: 'Версия зафиксирована', REOPEN: 'Открыт повторно', CONFIRM: 'Факт подтверждён по плану', CORRECTION: 'Исправление', LATE_ABSENCE: 'Позднее изменение отсутствия', REVIEW_REMOVED: 'Открыт для сверки' };
type Action = 'CLOSE' | 'REOPEN' | 'CONFIRM';
export default function TimesheetPage({ organization }: {
  organization: OrganizationSummary;
}) {
  const [params, setParams] = useSearchParams();
  const selectedMonth = params.get('month');
  const month = selectedMonth && /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(selectedMonth) ? selectedMonth : moveMonth(monthKeyInZone(new Date(), organization.timezone), -1);
  const subscription = useSubscription();
  const available = subscription.available('timesheets');
  const permitted = canAccess(organization, 'timesheets.view');
  const [historyPage, setHistoryPage] = useState(1);
  const query = useTimesheet(organization.id, month, permitted && available && !subscription.pending && !subscription.error, historyPage);
  const { apiRequest, downloadFile } = useAuth(), client = useQueryClient();
  const correction = useTimeCorrection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reasonAction, setReasonAction] = useState<Action | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const data = query.data, period = data?.period, status = period?.status ?? 'OPEN';
  const base = `/organizations/${organization.id}/schedule/timesheets/${month}`;
  async function act(action: Action, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<{ version: number }>(base + '/action', {
        method: 'POST',
        body: { action, revision: period?.revision ?? 0, snapshotToken: data?.snapshotToken, reason },
      });
      setHistoryPage(1);
      await invalidateOrganizationWork(client, organization.id);
      return result;
    }
    catch (failure) {
      setError(failure);
      // A lost response may mean the transition committed: read the state before
      // the user decides whether another action is still necessary.
      const refreshed = await query.refetch();
      const target = action === 'CLOSE' ? 'CLOSED' : 'OPEN';
      if (refreshed.data?.period?.revision === (period?.revision ?? 0) + 1
        && refreshed.data.period.status === target
        && refreshed.data.events.some(event => event.kind === action && event.actorMemberId === organization.viewerMemberId)) {
        setError(null);
        return { version: refreshed.data.period.version };
      }
      return false;
    }
    finally {
      setBusy(false);
    }
  }
  async function download(version: number) {
    setOperation({ phase: 'downloading', message: `Закрытый табель · версия ${version}` });
    try {
      await downloadFile(`${base}/versions/${version}/content`, `Staffly-${month}-v${version}.xlsx`);
      setOperation({ phase: 'completed', message: 'Файл передан браузеру.' });
    }
    catch (failure) {
      setOperation({ phase: 'failed', message: failure instanceof Error ? failure.message : 'Не удалось скачать табель.' });
    }
  }
  async function fixAndDownload() {
    const result = await act('CLOSE');
    if (result) await download(result.version);
  }
  function changeMonth(value: string) {
    setHistoryPage(1);
    setError(null);
    setOperation(null);
    setParams(current => { const next = new URLSearchParams(current); next.set('month', value); return next; });
  }
  if (subscription.pending) return <div className="route-loading" role="status">Проверяем доступ…</div>;
  if (subscription.error) return <RequestErrorState error={subscription.error} onRetry={() => subscription.refresh?.()} />;
  const tariffRejected = !query.isFetching && (query.error as { code?: string } | null)?.code === 'SUBSCRIPTION_FEATURE_REQUIRED';
  const reportsPermitted = canAccess(organization, 'reports.preview');
  if ((!available || !permitted || tariffRejected) && reportsPermitted && subscription.available('reports')) {
    return <section className="schedule-page timesheet-page">
      <ScheduleSectionHeader organization={organization} title="Табель и отчёты" description="Проверьте часы и отсутствия в предпросмотре перед выгрузкой Excel" />
      <TimesheetReports organization={organization} month={month} />
    </section>;
  }
  if (!available || tariffRejected) {
    return <Navigate replace to={`/app/organizations/${organization.id}/schedule${organization.locationId ? `?location=${organization.locationId}` : ''}`} />;
  }
  return <section className="schedule-page timesheet-page">
    <ScheduleSectionHeader organization={organization} title="Табель рабочего времени" description="Сверьте часы и отсутствия, зафиксируйте версию и скачайте Excel для бухгалтерии" />
    {!permitted ? <div className="app-state">Для просмотра табеля требуется разрешение.</div> : <>
      <div className="timesheet-toolbar">
        <div className="timesheet-month">
          <button type="button" className="app-secondary" aria-label="Предыдущий месяц" disabled={busy} onClick={() => changeMonth(moveMonth(month, -1))}>←</button>
          <label>
            <span>Месяц табеля</span>
            <input type="month" value={month} min="2000-01" max="2199-12" disabled={busy} onChange={event => {
              if (event.target.value)
                changeMonth(event.target.value);
            }} />
          </label>
          <button type="button" className="app-secondary" aria-label="Следующий месяц" disabled={busy} onClick={() => changeMonth(moveMonth(month, 1))}>→</button>
        </div>
        <span>
          {data?.snapshot.location ?? organization.location?.name} · {data?.snapshot.timezone ?? organization.timezone}
        </span>
        <WorkTimeRulesButton />
      </div>
      {query.isPending ? <div className="app-state" role="status">
        <span className="app-spinner" />Загружаем табель…</div> : query.isError ? <>
          <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />

        </> : data && <>
          <section className="timesheet-status" aria-label="Состояние табеля">
            <div>
              <span className={`timesheet-badge timesheet-badge--${status.toLowerCase()}`}>
                {statuses[status]}
              </span>
              <h2>
                {status === 'CLOSED' ? `Зафиксирована версия ${period!.version}` : period?.version ? 'Исправление ранее закрытого периода' : 'Сверка перед выгрузкой'}
              </h2>
              <p>
                {status === 'CLOSED'
                  ? 'Excel содержит сохранённые часы и отсутствия. Для изменений откройте период повторно.'
                  : 'Проверьте часы и отсутствия. Фиксация сохранит версию и закроет период для изменений.'}
              </p>
              {status === 'CLOSED' && (data.snapshot.closure || data.snapshot.approval) && <p>
                Зафиксировал: {data.snapshot.closure?.name ?? data.snapshot.approval?.reviewerName}
              </p>}
            </div>
            <div className="timesheet-actions">
              {status === 'OPEN' && data.capabilities.close && <button
                type="button"
                className="app-primary"
                disabled={busy || operation?.phase === 'downloading' || !!data.snapshot.issues.length}
                onClick={() => void fixAndDownload()}
              >{busy ? 'Фиксируем…' : 'Зафиксировать и скачать Excel'}</button>}
              {status === 'CLOSED' && data.capabilities.export && !!period?.version && <button
                type="button"
                className="app-primary"
                disabled={busy || operation?.phase === 'downloading'}
                onClick={() => void download(period.version)}
              >Скачать Excel · v{period.version}</button>}
              {status === 'CLOSED' && data.capabilities.reopen && <button type="button" className="app-secondary" disabled={busy} onClick={() => setReasonAction('REOPEN')}>Открыть для исправления</button>}
            </div>
          </section>

          {data.changedSinceClose && <p className="timesheet-notice" role="status">После закрытия данные изменились. Сохранённая версия не изменена; требуется проверка и новая версия табеля.</p>}
          {error != null && <p role="alert" className="form-inline-error">
            <RequestErrorMessage error={error} />
          </p>}
          <OperationStatus state={operation} />
          <div className="timesheet-metrics">
            <article>
              <span>Сотрудников</span>
              <strong>
                {data.snapshot.members.length}
              </strong>
            </article>
            <article>
              <span>План</span>
              <strong>
                {formatDuration(data.snapshot.members.reduce((sum, item) => sum + item.plannedMinutes, 0))}
              </strong>
            </article>
            <article>
              <span>Подтверждённый факт</span>
              <strong>
                {confirmedDuration(data.snapshot.members.reduce((sum, item) => sum + item.actualMinutes, 0), data.snapshot.members.reduce((sum, item) => sum + (item.confirmedShifts ?? item.workedShifts + item.noShows), 0))}
              </strong>
            </article>
            <article>
              <span>Без подтверждения</span>
              <strong>
                {data.snapshot.members.reduce((sum, item) => sum + (item.unconfirmedShifts ?? 0), 0)}
              </strong>
            </article>
          </div>
          {status !== 'CLOSED' && <section className="timesheet-checks">
            <header>
              <h2>Проверка периода <small>
                {data.snapshot.issues.length ? `Замечаний: ${data.snapshot.issues.length}` : 'Готов к фиксации'}
              </small>
              </h2>
              {status === 'OPEN' && data.capabilities.export && data.capabilities.actual && data.snapshot.shifts.some(shift => shift.attendance === 'UNCONFIRMED') && <button type="button" className="app-secondary" disabled={busy} onClick={() => period?.version ? setReasonAction('CONFIRM') : void act('CONFIRM')}>Подтвердить по плану</button>}
            </header>
            {data.snapshot.issues.length ? <ul>
              {data.snapshot.issues.slice(0, 30).map((issue, index) => <li key={`${issue.code}:${index}`}>
                <span>
                  {issue.message}
                </span>
                {issue.shiftId && status === 'OPEN' && data.capabilities.actual && <button type="button" className="app-secondary" onClick={() => correction?.open(issue.shiftId!, organization.locationId!)}>Исправить время</button>}{issue.requestId && <Link className="app-secondary timesheet-request-link" to={`/app/organizations/${organization.id}/requests?tab=incoming&request=${issue.requestId}`}>Открыть заявку</Link>}
              </li>)}
            </ul> : <p>Все смены подтверждены, влияющих нерешённых заявок нет.</p>}
          </section>}
          <section className="timesheet-content">
            <h2>Учёт по сотрудникам</h2>
            {data.snapshot.members.length ? <div className="timesheet-table-scroll" tabIndex={0} aria-label="Табель сотрудников">
              <table>
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>План</th>
                    <th>Факт</th>
                    <th>Без подтверждения</th>
                    <th>Неявки</th>
                    <th>Отпуск, дн.</th>
                    <th>Болезнь, дн.</th>
                    <th>Прочие, дн.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.snapshot.members.map(member => <tr key={member.id}>
                    <th scope="row">
                      <strong>
                        {member.name}
                      </strong>
                      <small>
                        {member.number ? `№ ${member.number}` : 'Без табельного номера'}{member.former ? ' · Бывший' : ''}
                      </small>
                      {member.positions && <small>
                        {member.positions}
                      </small>}
                    </th>
                    <td>
                      {formatDuration(member.plannedMinutes)}
                    </td>
                    <td>
                      {member.confirmedShifts === 0 ? '—' : formatDuration(member.actualMinutes)}
                    </td>
                    <td>{member.unconfirmedShifts ?? 0}</td>
                    <td>
                      {member.noShows}
                    </td>
                    <td>
                      {member.vacationDays}
                    </td>
                    <td>
                      {member.sickDays}
                    </td>
                    <td>
                      {member.otherAbsenceDays}
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <p className="timesheet-empty">За этот месяц нет сотрудников и данных для выбранной точки.</p>}<p className="timesheet-footnote">Перерывы включены в длительность. Отпуск указан без праздничных дней. Отсутствия не вычитаются из часов автоматически.</p>
          </section>
          <TimesheetDisclosure title="Смены" count={data.snapshot.shifts.length}>
            <ul>
              {data.snapshot.shifts.map(shift => <li key={shift.id}>
                <div>
                  <strong>
                    {shift.name}
                  </strong>
                  <small>
                    {shift.date.split('-').reverse().join('.')} · {shift.accounting ? workTimeStateNames[shift.accounting.state] : attendanceNames[shift.attendance]} · факт {shift.accounting?.confirmedMinutes === null ? '—' : formatDuration(shift.actualMinutes)}
                  </small>
                </div>
                {status === 'OPEN' && data.capabilities.actual && <button type="button" className="app-secondary" onClick={() => correction?.open(shift.id, organization.locationId!)}>Исправить время</button>}
              </li>)}
            </ul>
          </TimesheetDisclosure>
          <TimesheetDisclosure title="Отсутствия" count={data.snapshot.absences.length}>
            <ul>
              {data.snapshot.absences.map(item => <li key={item.id}>
                <div>
                  <strong>
                    {item.name} · {absenceNames[item.type] ?? 'Отсутствие'}
                  </strong>
                  <small>
                    {item.overlapStart} — {item.overlapEnd} · {item.days} календарных дн.</small>
                </div>
              </li>)}
            </ul>
          </TimesheetDisclosure>
          {!!data.versions.length && <section className="timesheet-versions" aria-label="Закрытые версии">
            <header><h2>Закрытые версии</h2><span>{data.versions.length}</span></header>
            <div className="timesheet-version-list">
              {data.versions.map(version => <article className="timesheet-version" key={version.version}>
                <span className="timesheet-file-icon"><TimesheetFileIcon /></span>
                <div className="timesheet-version__identity">
                  <div><strong>Табель · версия {version.version}</strong><span className="timesheet-version__state">{version.version === period?.version ? status === 'CLOSED' ? 'Текущая' : 'На исправлении' : 'Предыдущая'}</span></div>
                  <small>{new Date(version.closedAt).toLocaleString('ru-RU', { timeZone: data.snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' })} · Excel</small>
                </div>
                {data.capabilities.export && (status !== 'CLOSED' || version.version !== period?.version) && <button type="button" className="app-secondary" disabled={operation?.phase === 'downloading'} onClick={() => void download(version.version)}>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 3v9m-4-4 4 4 4-4M4 13v4h12v-4" /></svg>Скачать Excel
                </button>}
              </article>)}
            </div>
          </section>}
          <section className="timesheet-history" aria-label="История периода">
            <h2>История периода</h2>
            {data.events.length ? <ol className="timesheet-event-list">{data.events.map(event => <li className="timesheet-event" key={event.id}>
              <span className="timesheet-event__mark" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={event.kind === 'CLOSE' ? 'm5 10 3 3 7-7' : event.kind === 'REOPEN' || event.kind === 'RETURN' ? 'M4 8a6 6 0 1 1 0 5M4 4v4h4' : 'm5 14 1-4 7-7 3 3-7 7-4 1Z'} /></svg></span>
              <article>
                <header><strong>{eventNames[event.kind] ?? event.kind}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('ru-RU', { timeZone: data.snapshot.timezone, dateStyle: 'medium', timeStyle: 'short' })}</time></header>
                <span className="timesheet-event__actor">{event.actorName}</span>
                <p>{event.reason}</p>
                {event.changes != null && <TimesheetDisclosure title="Посмотреть изменения" compact><ChangeDetails changes={event.changes} timezone={data.snapshot.timezone} /></TimesheetDisclosure>}
              </article>
            </li>)}</ol> : <p className="timesheet-empty">Действий с периодом пока нет.</p>}
            {data.historyPagination?.pages > 1 && <nav className="timesheet-pagination" aria-label="Страницы истории табеля">
              <button type="button" className="app-secondary" disabled={busy || historyPage <= 1} onClick={() => setHistoryPage(page => page - 1)}>Более новые события</button>
              <span>{historyPage} / {data.historyPagination.pages}</span>
              <button type="button" className="app-secondary" disabled={busy || historyPage >= data.historyPagination.pages} onClick={() => setHistoryPage(page => page + 1)}>Более ранние события</button>
            </nav>}
          </section>
          {reasonAction && <ReasonDialog key={`${month}:${reasonAction}`} action={reasonAction} busy={busy} error={error} onClose={() => { setReasonAction(null); setError(null); }} onSubmit={async reason => Boolean(await act(reasonAction, reason))} />}
        </>}
    </>}
    {reportsPermitted && <TimesheetReports organization={organization} month={month} compact />}
  </section>;
}
function ReasonDialog({ action, busy, error, onClose, onSubmit }: {
  action: Action;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const safety = useFormSafety({ scope: 'timesheet-reason', value: { reason }, busy });
  const title = action === 'REOPEN' ? 'Открыть табель для исправления' : 'Подтвердить факт по плану';
  async function submit(event: FormEvent) {
    event.preventDefault(); if (await onSubmit(reason)) {
      safety.markSaved();
      onClose();
    }
  }
  return <AnimatedOverlay variant="modal" dismissible={!busy} beforeClose={safety.confirmClose} onClose={onClose}>
    {close => <DocumentDialog title={title} eyebrow="Табель" busy={busy} onClose={close}>
      <form className="timesheet-reason-form" onSubmit={event => void submit(event)}>
        <label>
          <span>Причина</span>
          <textarea required minLength={3} maxLength={1000} rows={4} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} />
        </label>
        {error != null && <p role="alert">
          <RequestErrorMessage error={error} />
        </p>}<footer>
          <button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
          <button className="app-primary" disabled={busy || reason.trim().length < 3}>
            {busy ? 'Сохраняем…' : title}
          </button>
        </footer>
      </form>
    </DocumentDialog>}
  </AnimatedOverlay>;
}
function ChangeDetails({ changes, timezone }: {
  changes: unknown;
  timezone: string;
}) {
  const value = changes as {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
  const labels: Record<string, string> = { scheduled_start_at: 'План: начало', scheduled_end_at: 'План: конец', actual_start_at: 'Факт: начало', actual_end_at: 'Факт: конец', attendance: 'Явка', start_date: 'Отсутствие: начало', end_date: 'Отсутствие: конец', type: 'Вид отсутствия', cancelled_at: 'Отменено', member_id: 'Сотрудник', location_id: 'Точка', break_minutes: 'Перерыв по плану', actual_break_minutes: 'Перерыв по факту', description: 'Комментарий', status: 'Статус', comment: 'Комментарий отсутствия' };
  function format(value: unknown) {
    if (value == null) return 'Не указано';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return new Date(value).toLocaleString('ru-RU', { timeZone: value.length > 10 ? timezone : 'UTC', dateStyle: 'medium', ...(value.length > 10 ? { timeStyle: 'short' as const } : {}) });
    }
    const text = String(value);
    const stateNames: Record<string, string> = {
      SCHEDULED: 'Назначена',
      CANCELLED: 'Отменена',
      OPEN: 'Сверка',
      REVIEW: 'На проверке',
      CLOSED: 'Зафиксирован',
    };
    return attendanceNames[text] ?? absenceNames[text] ?? stateNames[text] ?? text;
  }
  return <dl className="timesheet-changes">
    {Object.entries(labels).filter(([key]) => JSON.stringify(value.before?.[key]) !== JSON.stringify(value.after?.[key])).map(([key, label]) => <div key={key}>
      <dt>
        {label}
      </dt>
      <dd>
        <span><small>Было</small>{format(value.before?.[key])}</span><span><small>Стало</small>{format(value.after?.[key])}</span>
      </dd>
    </div>)}
  </dl>;
}
