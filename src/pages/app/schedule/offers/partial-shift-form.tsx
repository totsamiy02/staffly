import { openingHoursConfirmationFrom } from '../../../../shared/organization-profile.ts'
import OpeningHoursWarning from '../../organizations/opening-hours-warning.tsx'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { canAccess } from '../../../../app/access/catalog.ts'
import { useOrganizationMembers } from '../../../../app/organizations/queries.ts'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import { invalidateOrganizationWork } from '../../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import type { WorkShift } from '../../../../app/schedule/types.ts'
import { localDateTimeIso, zonedDateAndTime, shiftTimeRange } from '../../../../app/schedule/date-utils.ts'
import DatePicker, { TimeInput } from '../../../../component/ui/date-picker/date-picker.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import RequestErrorMessage from '../../../../component/ui/request-error-message.tsx'
import EmployeePicker from '../../shared/employee-picker.tsx'
import './partial-shift-form.scss'

type Props = { organization: OrganizationSummary; shift: WorkShift; onClose: () => void; onCreated: (id: string) => void }
export default function PartialShiftForm({ organization, shift, onClose, onCreated }: Props) {
  const { apiRequest } = useAuth()
  const cache = useQueryClient()
  const manager = canAccess(organization, 'schedule.actual') && canAccess(organization, 'schedule.edit')
  const members = useOrganizationMembers(canAccess(organization, 'members.view') ? organization.id : undefined)
  const [creationKey] = useState(() => crypto.randomUUID())
  const initial = zonedDateAndTime(new Date().toISOString(), organization.timezone)
  const [end, setEnd] = useState(initial)
  const [start, setStart] = useState(initial)
  const [firstBreak, setFirstBreak] = useState(0)
  const [nextBreak, setNextBreak] = useState(0)
  const [recipient, setRecipient] = useState('')
  const [audience, setAudience] = useState<'all' | 'person'>('all')
  const [direct, setDirect] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [openingToken, setOpeningToken] = useState<string>()
  const [acceptOpening, setAcceptOpening] = useState(false)
  const [workloadWarning, setWorkloadWarning] = useState(false)
  const [acceptWorkload, setAcceptWorkload] = useState(false)
  const [error, setError] = useState<unknown>()
  const safety = useFormSafety({ scope: 'partial-shift:' + shift.id, value: { end, start, firstBreak, nextBreak, recipient, audience, direct, reason }, busy, active: true })
  async function save() {
    setBusy(true)
    setError(undefined)
    try {
      const result = await apiRequest<{ offer: { id: string } }>('/organizations/' + organization.id + '/schedule/partial-offers', {
        method: 'POST', body: {
          acknowledgeWorkload: acceptWorkload, openingHoursConfirmation: acceptOpening ? openingToken : undefined, sourceShiftId: shift.id, creationKey, expectedUpdatedAt: shift.updatedAt,
          firstEndAt: localDateTimeIso(end.date, end.time, organization.timezone),
          replacementStartAt: localDateTimeIso(start.date, start.time, organization.timezone),
          firstBreakMinutes: firstBreak, replacementBreakMinutes: nextBreak,
          recipientMemberId: audience === 'person' ? recipient : null, direct: manager && audience === 'person' && direct, reason,
        },
      })
      safety.markSaved()
      await invalidateOrganizationWork(cache, organization.id)
      onCreated(result.offer.id)
      onClose()
    } catch (failure) { setError(failure); setOpeningToken(openingHoursConfirmationFrom(failure)); setAcceptOpening(false); setWorkloadWarning((failure as {code?:string}).code === 'WORKLOAD_WARNING') }
    finally { setBusy(false) }
  }
  return (
    <AnimatedOverlay variant="modal" className="shift-offer-overlay" beforeClose={safety.confirmClose} dismissible={!busy} onClose={onClose}>
      {close => <DocumentDialog title="Замена на остаток смены" eyebrow="Расписание" className="shift-offer-dialog partial-shift-dialog" busy={busy} onClose={close}>
        <form className="shift-offer-form" onSubmit={event => { event.preventDefault(); if (!busy) void save() }}>
          <div className="partial-shift-summary"><strong>{shift.memberName}</strong><span>{shiftTimeRange(shift.scheduledStartAt, shift.scheduledEndAt, organization.timezone)}</span></div>
          <fieldset disabled={busy}><legend>{manager ? 'Первый сотрудник закончил работу' : 'Предлагаемое время ухода'}</legend>
            <div className="partial-shift-grid"><label><span>Дата ухода</span><DatePicker required value={end.date} onChange={event => setEnd({ ...end, date: event.target.value })} /></label><label><span>Время ухода</span><TimeInput required value={end.time} onChange={event => setEnd({ ...end, time: event.target.value })} /></label></div>
            <label><span>Использованный перерыв, мин</span><input type="number" min={0} required value={firstBreak} onChange={event => setFirstBreak(Number(event.target.value))} /></label>
          </fieldset>
          <fieldset disabled={busy}><legend>Оставшаяся часть смены</legend>
            <div className="partial-shift-grid"><label><span>Дата выхода замены</span><DatePicker required value={start.date} onChange={event => setStart({ ...start, date: event.target.value })} /></label><label><span>Время выхода замены</span><TimeInput required value={start.time} onChange={event => setStart({ ...start, time: event.target.value })} /></label></div>
            <label><span>Перерыв замены, мин</span><input type="number" min={0} required value={nextBreak} onChange={event => setNextBreak(Number(event.target.value))} /></label>
          </fieldset>
          <SegmentedNav label="Поиск замены"><button type="button" aria-pressed={audience === 'all'} disabled={busy} onClick={() => setAudience('all')}>Предложить в точке</button><button type="button" aria-pressed={audience === 'person'} disabled={busy} onClick={() => setAudience('person')}>Выбрать коллегу</button></SegmentedNav>
          {audience === 'person' && <EmployeePicker label="Замена" disabled={busy} value={recipient} onChange={setRecipient} members={members.data?.members.filter(member => member.id !== shift.memberId) ?? []} />}
          {manager && audience === 'person' && <label className="partial-shift-check"><input type="checkbox" checked={direct} disabled={busy} onChange={event => setDirect(event.target.checked)} /><span>Замена согласована — назначить сразу</span></label>}
          <label><span>Причина</span><textarea required minLength={3} maxLength={500} rows={2} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
          <p className="offer-note">{manager ? 'Уход будет зафиксирован сразу. Пока замена не назначена, остаток остаётся непокрытым.' : 'Отработанное время и замена будут зафиксированы после согласования руководителем.'} Разрыв между уходом и выходом замены остаётся непокрытым. Перерывы указываются для каждой части отдельно.</p>
          {openingToken && <OpeningHoursWarning checked={acceptOpening} onChange={setAcceptOpening} />}
          {workloadWarning && <label className="partial-shift-check"><input type="checkbox" checked={acceptWorkload} onChange={event => setAcceptWorkload(event.target.checked)} /><span>Подтверждаю превышение месячной нормы</span></label>}
          {!!error && <p role="alert" className="form-inline-error"><RequestErrorMessage error={error} /></p>}
          <footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy || !shift.updatedAt || audience === 'person' && !recipient}>{busy ? 'Сохраняем…' : direct && audience === 'person' ? 'Назначить замену' : 'Предложить остаток'}</button></footer>
        </form>
      </DocumentDialog>}
    </AnimatedOverlay>
  )
}
