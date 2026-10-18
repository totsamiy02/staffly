import { useState } from 'react'
import { createPortal } from 'react-dom'
import './schedule/schedule.scss'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import type { DeparturePreview, DepartureScope, DepartureChoice, DepartureCandidate, DepartureResult, DepartureShift } from '../../app/organizations/departure.ts'
import { invalidateOrganizationWork } from '../../app/live-query.ts'
import { useTimeCorrection } from '../../app/schedule/time-correction-context.tsx'
import { displayDate, formatDuration, shiftTimeRange, zonedDateAndTime } from '../../app/schedule/date-utils.ts'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import AsyncPanel from '../../component/ui/async-panel.tsx'
import Select from '../../component/ui/select/select.tsx'
import SegmentedNav from '../../component/ui/segmented-nav/segmented-nav.tsx'
import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import './member-departure.scss'

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code

/** Reusable entry point: membership ID and explicit organization/point scope. */
export default function MemberDepartureDialog({ organization, memberId, scope, onClose, onCompleted }: { organization: OrganizationSummary; memberId: string; scope: DepartureScope; onClose: () => void; onCompleted?: () => void }) {
  const { apiRequest } = useAuth(), client = useQueryClient(), correction = useTimeCorrection()
  const [tab, setTab] = useState<'shifts' | 'consequences'>('shifts')
  const [choices, setChoices] = useState<Record<string, DepartureChoice>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [keepCurrent, setKeepCurrent] = useState(false), [acknowledgeDrafts, setAcknowledgeDrafts] = useState(false), [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const [picker, setPicker] = useState<DepartureShift | null>(null)
  const [result, setResult] = useState<DepartureResult | null>(null)
  const base = `/organizations/${organization.id}/members/${memberId}/departure`
  const suffix = `scope=${scope}&locationId=${organization.locationId}`
  const query = useQuery({ queryKey: ['member-departure', organization.id, organization.locationId, memberId, scope], queryFn: () => apiRequest<DeparturePreview>(`${base}?${suffix}`), staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false })
  const data = query.data
  const future = data?.shifts.filter(s => !s.current) ?? [], current = data?.shifts.filter(s => s.current) ?? []
  const cancelled = future.filter(s => choices[s.id]?.action === 'cancel'), reassigned = future.filter(s => choices[s.id]?.action === 'reassign' && choices[s.id]?.memberId)
  const unready = future.some(s => s.hasActual || !choices[s.id] || choices[s.id].action === 'reassign' && !choices[s.id].memberId)
  const affectedCoverage = data?.coverage.filter(segment => segment.shiftIds.some(id => choices[id]?.action === 'cancel')) ?? []
  const root = `/app/organizations/${organization.id}`
  const mutation = useMutation({
    mutationFn: () => apiRequest<DepartureResult>(`${base}?locationId=${organization.locationId}`, { method: 'POST', body: { scope, token: data!.token, reason, choices: future.flatMap(s => choices[s.id] ? [choices[s.id]] : []), keepCurrent, acknowledgeDrafts, acknowledgeWorkload } }),
    onSuccess: async value => {
      setResult(value); onCompleted?.()
      await Promise.all([invalidateOrganizationWork(client, organization.id), client.invalidateQueries({ queryKey: ['organization-members', organization.id] }), client.invalidateQueries({ queryKey: ['organizations'] }), client.invalidateQueries({ queryKey: ['schedule-planning', organization.id] }), client.invalidateQueries({ queryKey: ['access-audit', organization.id] }), ...['documents', 'document', 'document-progress', 'document-members', 'personal-documents'].map(key => client.invalidateQueries({ queryKey: [key, organization.id] }))])
    },
  })
  const stale = errorCode(mutation.error) === 'DEPARTURE_CHANGED'
  const busy = mutation.isPending || query.isFetching
  const refresh = async () => { mutation.reset(); setChoices({}); setNames({}); setKeepCurrent(false); setAcknowledgeDrafts(false); setAcknowledgeWorkload(false); await query.refetch() }
  const choose = (shiftId: string, action: string) => { setAcknowledgeWorkload(false); setChoices(value => { const next = { ...value }; if (!action) delete next[shiftId]; else next[shiftId] = { shiftId, action: action as 'cancel' | 'reassign' }; return next }) }
  const scheduleLink = (s: DepartureShift) => `${root}/schedule?location=${s.locationId}&shift=${s.id}&date=${zonedDateAndTime(s.startAt, s.timezone).date}`
  const title = result ? scope === 'organization' ? 'Сотрудник исключён' : 'Сотрудник убран из точки' : scope === 'organization' ? 'Исключить сотрудника' : 'Убрать сотрудника из точки'
  return <AnimatedOverlay variant="modal" dismissible={!mutation.isPending && !picker} onClose={onClose}>{close => <DocumentDialog className="member-departure" title={title} eyebrow="Последствия исключения" busy={mutation.isPending} onClose={close}>
    {result ? <div className="departure-content"><div className="departure-success" role="status"><span aria-hidden="true">✓</span><h3>{data?.member.name}</h3><p>{scope === 'organization' ? 'Доступ к организации закрыт.' : `Сотрудник убран из состава точки «${data?.locationName}».`}</p></div><div className="departure-metrics"><div><strong>{result.reassigned}</strong><span>смен передано</span></div><div><strong>{result.cancelled}</strong><span>смен отменено</span></div><div><strong>{result.retainedCurrent}</strong><span>текущих сохранено</span></div></div><p className="departure-note">История работы, учтённые часы и документы сохранены. Решение записано в историю доступа.</p><footer><a className="app-secondary" href={`${root}/schedule?location=${result.locationId}`}>Открыть расписание</a><button autoFocus className="app-primary" onClick={close}>Готово</button></footer></div> : <div className="departure-content">
      <AsyncPanel pending={query.isLoading} minHeight={260}>{query.isError ? <div className="departure-empty" role="alert"><p>{query.error.message}</p><button className="app-secondary" onClick={() => void refresh()}>Повторить</button></div> : data && <>
        <div className="departure-person"><Avatar url={data.member.avatarUrl} name={data.member.name} className="app-avatar" /><div><strong>{data.member.name}</strong><span>{scope === 'organization' ? 'Вся организация' : data.locationName}</span></div><span className="departure-scope">{scope === 'organization' ? 'Организация' : 'Одна точка'}</span></div>
        <div className="departure-metrics"><div><strong>{future.length}</strong><span>Будущие смены</span></div><div><strong>{formatDuration(future.reduce((sum, s) => sum + s.minutes, 0))}</strong><span>по расписанию</span></div><div><strong>{new Set(future.map(s => s.locationId)).size}</strong><span>Точки со сменами</span></div></div>

        <div className="departure-tabs"><SegmentedNav label="Последствия исключения"><button className={tab === 'shifts' ? 'active' : ''} aria-pressed={tab === 'shifts'} onClick={() => setTab('shifts')}>Смены · {data.shifts.length}</button><button className={tab === 'consequences' ? 'active' : ''} aria-pressed={tab === 'consequences'} onClick={() => setTab('consequences')}>Другие последствия</button></SegmentedNav><button className="departure-link" disabled={busy} onClick={() => void refresh()}>Обновить</button></div>
        <AsyncPanel pending={false} identity={tab} minHeight={data.shifts.length ? 200 : 120}>{tab === 'shifts' ? <>
          {current.length > 0 && <section className="departure-warning"><h3>Смена уже началась</h3><p>Проверьте учтённое время. Текущие смены останутся за сотрудником в истории.</p>{current.map(s => <div className="departure-current" key={s.id}><div><strong>{displayDate(zonedDateAndTime(s.startAt, s.timezone).date)} · {shiftTimeRange(s.startAt, s.endAt, s.timezone)}</strong><small>{s.locationName}</small></div>{correction?.canOpen(s.locationId) && <button className="app-secondary" disabled={busy} onClick={() => correction.open(s.id, s.locationId)}>Исправить время</button>}<a href={scheduleLink(s)} target="_blank" rel="noreferrer" className="departure-link">Открыть смену</a></div>)}<label className="departure-check"><input type="checkbox" checked={keepCurrent} disabled={busy} onChange={e => setKeepCurrent(e.target.checked)} /><span>Сохранить текущие смены и их учтённое время при исключении</span></label></section>}
          {!future.length ? <div className="departure-empty"><strong>Будущих смен нет</strong><p>Переназначать или отменять смены не потребуется.</p></div> : <>
            <div className="departure-section-head"><h3>Будущие смены</h3><button className="departure-link" disabled={busy || stale || !future.some(s => s.canCancel && !s.hasActual)} onClick={() => { setChoices(Object.fromEntries(future.filter(s => s.canCancel && !s.hasActual).map(s => [s.id, { shiftId: s.id, action: 'cancel' as const }]))); setAcknowledgeWorkload(false) }}>Отменить все доступные</button></div>
            <div className="departure-shifts">{future.map(s => <article key={s.id} className="departure-shift"><div><a className="departure-shift-date" href={scheduleLink(s)} target="_blank" rel="noreferrer">{displayDate(zonedDateAndTime(s.startAt, s.timezone).date)}</a><strong>{shiftTimeRange(s.startAt, s.endAt, s.timezone)}</strong><small>{s.locationName}{s.positionName ? ` · ${s.positionName}` : ''}</small></div><div className="departure-shift-choice">{s.hasActual ? <p className="form-inline-error">Есть учтённое время. Сначала проверьте смену в расписании.</p> : <><Select aria-label={`Действие со сменой ${displayDate(zonedDateAndTime(s.startAt, s.timezone).date)}`} disabled={busy || stale} value={choices[s.id]?.action ?? ''} onChange={e => choose(s.id, e.target.value)}><option value="">Выберите действие</option><option value="reassign" disabled={!s.canReassign}>Передать сотруднику</option><option value="cancel" disabled={!s.canCancel}>Отменить с причиной</option></Select>{choices[s.id]?.action === 'reassign' && <button className="departure-replacement" disabled={busy || stale} onClick={() => setPicker(s)}>{names[s.id] ?? 'Подобрать замену'} </button>}{!s.canCancel && !s.canReassign && <small>Для изменения смены нужны права управления расписанием этой точки.</small>}</>}</div></article>)}</div>
          </>}
          {cancelled.length > 0 && <label className="departure-reason"><span>Причина отмены смен</span><textarea rows={2} maxLength={500} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} placeholder="Например: сотрудник покинул команду" /><small>Попадёт в историю каждой отменённой смены.</small></label>}
          {affectedCoverage.length > 0 && <div className="departure-warning"><strong>Потребность останется незакрытой</strong><p>Отмена выбранных смен увеличит нехватку сотрудников в {affectedCoverage.length} интервалах.</p><details><summary>Посмотреть интервалы</summary>{affectedCoverage.map((s, i) => <p key={i}>{displayDate(s.date)} · {shiftTimeRange(s.startAt, s.endAt, s.timezone)} · {s.locationName} · {s.positionName}</p>)}</details></div>}
        </> : <div className="departure-consequences">
          <article><strong>Заявки на рассмотрении · {data.pendingRequests}</strong><p>Сохранятся для решения руководителя и останутся в истории.</p>{data.pendingRequests > 0 && <a className="departure-link" href={`${root}/requests?location=${data.locationId}&tab=incoming`} target="_blank" rel="noreferrer">Открыть заявки</a>}</article>
          <article><strong>Связанные изменения смен · {data.closingRequests}</strong><p>Заявки на изменение отменяемых или передаваемых смен закроются с записью причины.</p></article>
          <article><strong>Передачи и обмены · {data.offers}</strong><p>Активные предложения с участием сотрудника закроются; резервирование смен будет снято.</p></article>
          <article><strong>Предварительные графики · {data.drafts.length}</strong><p>{data.drafts.length ? 'Назначения требуют проверки в согласовании графика. Графики и обсуждения сохраняются; применить недопустимое назначение система не позволит.' : 'Связанных незавершённых графиков нет.'}</p>{data.drafts.map(d => d.canOpen ? <a key={d.id} className="departure-link" href={`${root}/schedule/drafts/${d.id}?location=${d.locationId}`} target="_blank" rel="noreferrer">{d.title}</a> : <p key={d.id}>{d.title} · обратитесь к руководителю точки</p>)}</article>
          <article><strong>Доступ и документы</strong><p>{scope === 'organization' ? `Доступ ко всей организации закроется. Незавершённые ознакомления (${data.acknowledgements}) будут отменены; файлы и история прочтений сохранятся.` : `Членство в организации сохранится.${data.remainingLocations.length ? ` Другие точки: ${data.remainingLocations.join(', ')}.` : ''} Локальная роль этой точки и временные назначения в неё будут сняты. Документы и история сохранятся.`}</p>{data.globalAccessRemains && <p className="departure-warning">Общая роль сотрудника действует во всей организации и продолжит давать доступ к этой точке. Изменить её можно в настройках доступа.</p>}</article>
          <p className="departure-note">Ссылки открываются в новой вкладке. После правок вернитесь сюда и обновите предпросмотр.</p>
        </div>}</AsyncPanel>
        {data.drafts.length > 0 && <label className="departure-check"><input type="checkbox" checked={acknowledgeDrafts} disabled={busy} onChange={e => setAcknowledgeDrafts(e.target.checked)} /><span>Проверю назначения в связанных предварительных графиках</span></label>}
        {errorCode(mutation.error) === 'WORKLOAD_WARNING' && <label className="departure-check"><input type="checkbox" checked={acknowledgeWorkload} disabled={busy} onChange={e => setAcknowledgeWorkload(e.target.checked)} /><span>Подтверждаю превышение месячной нормы у выбранной замены</span></label>}
        {stale && <div className="departure-warning" role="alert"><strong>Данные успели измениться</strong><p>Расписание или связанные дела обновились. Проверьте новый список перед исключением.</p><button className="app-secondary" disabled={busy} onClick={() => void refresh()}>Обновить предпросмотр</button></div>}
        {mutation.error && !stale && <p className="form-inline-error" role="alert">{mutation.error.message}</p>}
        <p className="departure-note">Прошедшие смены и учтённые часы сохранятся.{future.length > 0 && ` Выбрано: передать ${reassigned.length}, отменить ${cancelled.length}.`}</p>
        <footer><button className="app-secondary" disabled={mutation.isPending} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || stale || unready || current.length > 0 && !keepCurrent || data.drafts.length > 0 && !acknowledgeDrafts || cancelled.length > 0 && reason.trim().length < 3} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : future.length ? scope === 'organization' ? 'Применить и исключить' : 'Применить и убрать из точки' : scope === 'organization' ? 'Исключить сотрудника' : 'Убрать из точки'}</button></footer>
      </>}</AsyncPanel>
    </div>}
    {picker && createPortal(<ReplacementPicker base={base} suffix={suffix} shift={picker} onClose={() => setPicker(null)} onSelect={person => { setChoices(value => ({ ...value, [picker.id]: { shiftId: picker.id, action: 'reassign', memberId: person.id } })); setNames(value => ({ ...value, [picker.id]: person.name })); setAcknowledgeWorkload(false); setPicker(null) }} />, document.body)}
  </DocumentDialog>}</AnimatedOverlay>
}

function ReplacementPicker({ base, suffix, shift, onClose, onSelect }: { base: string; suffix: string; shift: DepartureShift; onClose: () => void; onSelect: (candidate: DepartureCandidate) => void }) {
  const { apiRequest } = useAuth()
  const [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ['departure-candidates', base, suffix, shift.id, search, page], queryFn: () => apiRequest<{ candidates: DepartureCandidate[]; hasMore: boolean }>(`${base}/candidates?${suffix}&shiftId=${shift.id}&search=${encodeURIComponent(search)}&page=${page}`), retry: false })
  return <AnimatedOverlay variant="modal" onClose={onClose}>{close => <DocumentDialog className="member-departure departure-picker" title="Подобрать замену" eyebrow="Передача смены" onClose={close}><div className="departure-content"><p className="departure-note">{displayDate(zonedDateAndTime(shift.startAt, shift.timezone).date)} · {shiftTimeRange(shift.startAt, shift.endAt, shift.timezone)} · {shift.locationName}</p><label className="departure-reason"><span>Сотрудник</span><input type="search" autoFocus placeholder="Поиск по имени" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} /></label><AsyncPanel pending={query.isLoading} identity={`${search}:${page}`} minHeight={220}>{query.isError ? <p role="alert" className="form-inline-error">{query.error.message} <button className="departure-link" onClick={() => void query.refetch()}>Повторить</button></p> : <div className="departure-candidates">{query.data?.candidates.map(person => <button disabled={!!person.reason} key={person.id} onClick={() => onSelect(person)}><span><strong>{person.name}</strong><small>{person.reason ?? 'Доступен для этой смены'}</small></span></button>)}{query.data?.candidates.length === 0 && <p className="departure-empty">Подходящих сотрудников не найдено. Можно выбрать отмену смены.</p>}</div>}</AsyncPanel><footer><button className="app-secondary" disabled={page === 1 || query.isFetching} onClick={() => setPage(p => p - 1)}>Назад</button><span>Страница {page}</span><button className="app-secondary" disabled={!query.data?.hasMore || query.isFetching} onClick={() => setPage(p => p + 1)}>Далее</button></footer></div></DocumentDialog>}</AnimatedOverlay>
}
