import OperationStatus from '../../../component/ui/operation-status.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import RequestTypeChooser from './types/request-type-chooser.tsx'
import RequestIcon from './request-icon.tsx'
import FilePicker from '../../../component/ui/file-picker/file-picker.tsx'
import VacationBalancePreview from './vacations/vacation-balance-card.tsx'
import VacationWarning from './vacations/vacation-warning.tsx'
import { type RequestAnswers } from '../../../app/requests/workflow.ts'
import { WorkflowFields } from './types/workflow-fields.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import { useOrganizationDirectory } from '../../../app/organizations/queries.ts'
import { useSchedulePlanning } from '../../../app/schedule/planning/planning.ts'
import EmployeePicker from '../shared/employee-picker.tsx'
import { useToast, useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import { absenceDays } from '../../../app/schedule/absence-format.ts'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import DatePicker, { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import Select from '../../../component/ui/select/select.tsx'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { useMyUpcomingShifts } from '../../../app/schedule/queries.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useRequestTypes } from '../../../app/requests/queries.ts'
import type { RequestSystemCode, StaffRequest, RequestMutationResponse } from '../../../app/requests/types.ts'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import './requests.scss'
import './requests-redesign.scss'
import { shiftWindow, absenceReasonLabels } from './request-format.ts'

export function RequestForm({ organization, request, initialShiftId, initialProposal = false, initialProposalDate, initialSystemCode, onClose }: { organization: OrganizationSummary; request?: StaffRequest | null; initialShiftId?: string; initialProposal?: boolean; initialProposalDate?: string; initialSystemCode?: RequestSystemCode; onClose: () => void }) {
  const toast = useToast()
  const { apiRequest, uploadFile } = useAuth()
  const queryClient = useQueryClient()
  const typeQuery = useRequestTypes(organization.id, !!request)
  const types = useMemo(() => {
    const available = [...(typeQuery.data?.types ?? [])]
    if (request && !available.some(type => type.id === request.requestTypeId)) available.push({
      id: request.requestTypeId,
      name: request.typeNameSnapshot,
      description: null,
      systemCode: request.systemCodeSnapshot,
      dateMode: request.formSnapshot?.dateMode ?? 'NONE',
      requiresComment: request.formSnapshot?.requiresComment ?? false,
      allowsAttachments: request.formSnapshot?.allowsAttachments ?? false,
      definition: request.formSnapshot,
      isActive: false
    })
    return available.filter(type => (type.isActive || type.id === request?.requestTypeId) && type.systemCode !== 'STAFFING_RESPONSE' && (type.systemCode !== 'STAFFING' || canAccess(organization, 'staffing.create')))
  }, [typeQuery.data, organization, request])
  const planning = useSchedulePlanning(organization.id)
  const positions = planning.data?.positions.filter(position => position.isActive) ?? []
  const [choosingType, setChoosingType] = useState(!request && !initialSystemCode && !initialShiftId && !initialProposal)
  const [staffingPositionId, setStaffingPositionId] = useState('')
  const [staffingPositionName, setStaffingPositionName] = useState('')
  const shifts = useMyUpcomingShifts(organization.id)
  const [typeId, setTypeId] = useState(request ? request.requestTypeId : types.find(type => type.systemCode === (initialSystemCode ?? (initialShiftId ? 'SHIFT_CHANGE' : initialProposal ? 'SHIFT_PROPOSAL' : '')))?.id ?? types[0]?.id ?? '')
  const [startDate, setStartDate] = useState(request?.startDate ?? '')
  const [endDate, setEndDate] = useState(request?.endDate ?? '')
  const [absenceReason, setAbsenceReason] = useState(request?.absenceReason ?? 'SICK')
  const [comment, setComment] = useState(request?.comment ?? '')
  const [shiftId, setShiftId] = useState(request?.relatedShiftId ?? initialShiftId ?? '')
  const [proposedStartDate, setProposedStartDate] = useState(request?.proposedStartAt ? zonedDateAndTime(request.proposedStartAt, organization.timezone).date : initialProposal || initialSystemCode === 'STAFFING' ? initialProposalDate ?? '' : '')
  const [proposedStartTime, setProposedStartTime] = useState(request?.proposedStartAt ? zonedDateAndTime(request.proposedStartAt, organization.timezone).time : initialProposal || initialSystemCode === 'STAFFING' ? '09:00' : '')
  const [proposedEndDate, setProposedEndDate] = useState(request?.proposedEndAt ? zonedDateAndTime(request.proposedEndAt, organization.timezone).date : initialProposal || initialSystemCode === 'STAFFING' ? initialProposalDate ?? '' : '')
  const [proposedEndTime, setProposedEndTime] = useState(request?.proposedEndAt ? zonedDateAndTime(request.proposedEndAt, organization.timezone).time : initialProposal || initialSystemCode === 'STAFFING' ? '18:00' : '')
  const [files, setFiles] = useState<File[]>([])
  const [answers, setAnswers] = useState<RequestAnswers>(request?.answers ?? {})
  const [savedId, setSavedId] = useState(request?.id ?? '')
  const [submissionKey] = useState(() => crypto.randomUUID())
  const [subjectMemberId, setSubjectMemberId] = useState('')
  const directory = useOrganizationDirectory(organization.id, canAccess(organization, 'requests.onBehalf'))
  const [uploaded, setUploaded] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useToastFeedback('', error)
  const safety = useFormSafety({
    scope: 'request:' + organization.id + ':' + organization.locationId + ':' + (request?.id ?? 'new'),
    value: {
      typeId,
      startDate,
      endDate,
      absenceReason,
      comment,
      shiftId,
      proposedStartDate,
      proposedStartTime,
      proposedEndDate,
      proposedEndTime,
      answers,
      subjectMemberId,
      staffingPositionId,
      staffingPositionName,
      files: files.map(file => ({
        name: file.name,
        size: file.size,
        modified: file.lastModified
      }))
    },
    active: !choosingType && !!typeId && typeQuery.isSuccess,
    busy
  })
  const selectedType = types.find((item) => item.id === typeId)
  const type = selectedType && request?.requestTypeId === selectedType.id ? {
    ...selectedType,
    dateMode: request.formSnapshot?.dateMode ?? selectedType.dateMode,
    requiresComment: request.formSnapshot?.requiresComment ?? selectedType.requiresComment,
    allowsAttachments: request.formSnapshot?.allowsAttachments ?? selectedType.allowsAttachments
  } : selectedType
  useEffect(() => {
    if (!typeId && types.length) setTypeId(types.find(type => type.systemCode === (initialSystemCode ?? (initialShiftId ? 'SHIFT_CHANGE' : initialProposal ? 'SHIFT_PROPOSAL' : '')))?.id ?? types[0].id)
  }, [types, typeId, initialShiftId, initialProposal, initialSystemCode])
  const selectedShift = shifts.data?.shifts.find((item) => item.id === shiftId)
  function chooseShift(id: string) {
    setShiftId(id)
    const shift = shifts.data?.shifts.find((item) => item.id === id)
    const start = shift ? zonedDateAndTime(shift.scheduledStartAt, organization.timezone) : null
    const end = shift ? zonedDateAndTime(shift.scheduledEndAt, organization.timezone) : null
    if (type?.systemCode === 'DAY_OFF') {
      setStartDate(start?.date ?? '')
      setEndDate(start?.date ?? '')
    }
    setProposedStartDate(start?.date ?? '')
    setProposedStartTime(start?.time ?? '')
    setProposedEndDate(end?.date ?? '')
    setProposedEndTime(end?.time ?? '')
  }
  useEffect(() => {
    if (initialShiftId && !request && !proposedStartDate && shifts.data?.shifts.some(shift => shift.id === initialShiftId)) {
      const shift = shifts.data.shifts.find(item => item.id === initialShiftId)!
      const start = zonedDateAndTime(shift.scheduledStartAt, organization.timezone)
      const end = zonedDateAndTime(shift.scheduledEndAt, organization.timezone)
      if (initialSystemCode === 'DAY_OFF') {
        setStartDate(start.date)
        setEndDate(start.date)
      }
      setProposedStartDate(start.date)
      setProposedStartTime(start.time)
      setProposedEndDate(end.date)
      setProposedEndTime(end.time)
    }
  }, [initialShiftId, shifts.data, request, proposedStartDate, organization.timezone, initialSystemCode])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!type) return
    setBusy(true)
    setError('')
    try {
      if (['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') && Date.parse(`${proposedEndDate}T${proposedEndTime}:00Z`) <= Date.parse(`${proposedStartDate}T${proposedStartTime}:00Z`)) throw new Error('Окончание смены должно быть позже начала.')
      if (files.length + (request?.attachments.length ?? 0) > 5) throw new Error('К заявке можно добавить не больше пяти файлов.')
      if (files.some((file) => file.size > 10 * 1024 * 1024)) throw new Error('Каждый файл должен весить не больше 10 МБ.')
      const result = await apiRequest<RequestMutationResponse>(`/organizations/${organization.id}/requests${savedId ? `/${savedId}` : ''}`, {
        method: savedId ? 'PATCH' : 'POST',
        body: {
          draft: type.systemCode !== 'SICK',
          submissionKey,
          answers,
          subjectMemberId: subjectMemberId || undefined,
          ...(type.systemCode === 'STAFFING' ? {
            staffingPositionId: staffingPositionId || null,
            staffingPositionName: staffingPositionId ? null : staffingPositionName
          } : {}),
          requestTypeId: typeId,
          startDate: startDate || null,
          endDate: endDate || null,
          comment: comment || null,
          absenceReason: type.systemCode === 'SICK' ? absenceReason : null,
          relatedShiftId: ['SHIFT_CHANGE', 'DAY_OFF'].includes(type.systemCode ?? '') ? shiftId || null : null,
          proposedStartDate: ['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') ? proposedStartDate : null,
          proposedStartTime: ['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') ? proposedStartTime : null,
          proposedEndDate: ['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') ? proposedEndDate : null,
          proposedEndTime: ['SHIFT_CHANGE', 'SHIFT_PROPOSAL', 'STAFFING'].includes(type.systemCode ?? '') ? proposedEndTime : null
        }
      })
      setSavedId(result.request.id)
      for (const file of files) {
        const key = file.name + ':' + file.size + ':' + file.lastModified
        if (uploaded.includes(key)) continue
        await uploadFile(`/organizations/${organization.id}/requests/${result.request.id}/attachments`, file)
        setUploaded(current => [...current, key])
      }
      if (type.systemCode !== 'SICK') await apiRequest(`/organizations/${organization.id}/requests/${result.request.id}/submit`, {
        method: 'POST',
        body: {}
      })
      await invalidateOrganizationWork(queryClient, organization.id)
      toast(type.systemCode === 'SICK' ? request ? 'Сообщение обновлено' : 'Отсутствие зарегистрировано' : request ? 'Заявка обновлена' : 'Заявка отправлена', 'success')
      safety.markSaved()
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось отправить заявку.')
    }
    finally {
      setBusy(false)
    }
  }
  if (!request && !typeQuery.isLoading && !typeQuery.isError && (initialSystemCode || initialProposal || initialShiftId) && !types.some(t => t.systemCode === (initialSystemCode ?? (initialShiftId ? 'SHIFT_CHANGE' : 'SHIFT_PROPOSAL')))) return <DocumentDialog title="Действие недоступно" onClose={() => void safety.close(onClose)}>
    <p>Новая подача этого типа отключена в настройках. Действующие записи и история сохранены.</p>
  </DocumentDialog>
  if (choosingType) return <RequestTypeChooser
    types={types}
    loading={typeQuery.isLoading}
    error={typeQuery.isError}
    retry={typeQuery.refetch}
    onClose={() => void safety.close(onClose)}
    onSelect={item => {
      setTypeId(item.id)
      setStartDate('')
      setEndDate('')
      chooseShift('')
      setChoosingType(false)
    }} />
  return <DocumentDialog
    key="request-form"
    className="request-form-dialog"
    eyebrow="Заявки"
    busy={busy}
    onClose={() => void safety.close(onClose)}
    title={type?.systemCode === 'SICK' ? request ? 'Изменить сообщение' : 'Сообщить об отсутствии' : request ? 'Редактировать заявку' : 'Создать заявку'}>
    <form ref={safety.ref} onSubmit={submit}>
      {typeQuery.isLoading ? <p className="app-state"><span className="app-spinner" />Загружаем типы заявок…</p> : typeQuery.isError ? <div className="app-state">
        <p>Не удалось загрузить типы заявок.</p>
        <button
          type="button"
          className="app-secondary"
          onClick={() => void typeQuery.refetch()}>Повторить</button>
      </div> : null}
      <div className="request-form-purpose">
        <RequestIcon code={type?.systemCode} />
        <span>
          <strong>
            {type?.name}
          </strong>
          {type?.description && <small>
            {type.description}
          </small>}
        </span>
      </div>
      {!request && canAccess(organization, 'requests.onBehalf') && (!type?.systemCode || type.systemCode === 'VACATION') && <EmployeePicker
        label="Оформить для сотрудника"
        emptyLabel="Для себя"
        required={false}
        value={subjectMemberId}
        onChange={setSubjectMemberId}
        members={directory.data?.members ?? []} />}
      <WorkflowFields
        organizationId={organization.id}
        definition={request?.formSnapshot ?? type?.definition}
        answers={answers}
        onChange={setAnswers} />
      {type?.systemCode === 'SICK' && <label>
        <span>Причина отсутствия</span>
        <Select value={absenceReason} onChange={event => setAbsenceReason(event.target.value as typeof absenceReason)}>
          {Object.entries(absenceReasonLabels).map(([value, label]) => <option key={value} value={value}>
            {label}
          </option>)}
        </Select>
      </label>}
      {type?.dateMode !== 'NONE' && <div className="request-date-fields">
        <label>
          <span>
            {type?.dateMode === 'SINGLE' ? type.systemCode === 'DAY_OFF' ? 'Дата отгула' : 'Дата события' : 'Первый день'}
          </span>
          <DatePicker
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value)
              if (type?.systemCode === 'DAY_OFF' && selectedShift && zonedDateAndTime(selectedShift.scheduledStartAt, organization.timezone).date !== event.target.value) setShiftId('')
            }}
            required />
        </label>
        {type?.dateMode === 'RANGE' && <label>
          <span>Последний день</span>
          <DatePicker
            min={startDate}
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            required />
        </label>}
      </div>}
      {type?.systemCode === 'VACATION' && <>
        <VacationWarning
          organizationId={organization.id}
          startDate={startDate}
          endDate={endDate}
          memberId={request?.createdByMemberId ?? (subjectMemberId || undefined)} />
        <VacationBalancePreview
          organization={organization}
          startDate={startDate}
          endDate={endDate}
          memberId={request?.createdByMemberId ?? (subjectMemberId || undefined)}
          requestId={request?.id} />
      </>}
      {" "}
      {type?.systemCode === 'VACATION' && startDate && endDate && <p className="absence-note">Один из периодов за рабочий год должен составлять не менее 14 дней. Кадровые документы оформляются вне сайта.</p>}
      {startDate && type?.dateMode !== 'NONE' && type?.systemCode !== 'VACATION' && <p className="absence-note">Календарных дней: {absenceDays(startDate, type?.dateMode === 'SINGLE' ? startDate : endDate || startDate)}</p>}
      {['SHIFT_CHANGE', 'DAY_OFF'].includes(type?.systemCode ?? '') && <label>
        <span>
          {type?.systemCode === 'DAY_OFF' ? 'Смена для отгула (необязательно)' : 'Текущая смена'}
        </span>
        <Select
          value={shiftId}
          onChange={(event) => chooseShift(event.target.value)}
          required={type?.systemCode === 'SHIFT_CHANGE'}>
          <option value="">Выберите свою смену</option>
          {shifts.data?.shifts.filter((shift) => new Date(shift.scheduledStartAt).getTime() > Date.now()).map((shift) => <option value={shift.id} key={shift.id}>{displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)} · {formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</option>)}
        </Select>
      </label>}
      {(type?.systemCode === 'STAFFING' || type?.systemCode === 'SHIFT_PROPOSAL' || (type?.systemCode === 'SHIFT_CHANGE' && selectedShift)) && <div className="request-shift-proposal">
        <p>
          {selectedShift ? <>Текущая смена: {shiftWindow(selectedShift.scheduledStartAt, selectedShift.scheduledEndAt, organization.timezone)} → предлагаемое изменение</> : type?.systemCode === 'STAFFING' ? <>Подмена в точке «{organization.location?.name}». Смену получит сотрудник после подтверждения отклика.</> : <>Предлагаемая новая смена. Она появится в расписании после одобрения.</>}
        </p>
        <div>
          <fieldset>
            <legend>Предлагаемое начало</legend>
            <label>
              <span>Дата</span>
              <DatePicker
                value={proposedStartDate}
                onChange={(event) => setProposedStartDate(event.target.value)}
                required />
            </label>
            <label>
              <span>Время</span>
              <TimeInput
                value={proposedStartTime}
                onChange={(event) => setProposedStartTime(event.target.value)}
                required />
            </label>
          </fieldset>
          <fieldset>
            <legend>Предлагаемое окончание</legend>
            <label>
              <span>Дата</span>
              <DatePicker
                min={proposedStartDate}
                value={proposedEndDate}
                onChange={(event) => setProposedEndDate(event.target.value)}
                required />
            </label>
            <label>
              <span>Время</span>
              <TimeInput
                value={proposedEndTime}
                onChange={(event) => setProposedEndTime(event.target.value)}
                required />
            </label>
          </fieldset>
        </div>
      </div>}
      {type?.systemCode === 'STAFFING' && <label>
        <span>Кто нужен на смену</span>
        {positions.length ? <Select
          required
          value={staffingPositionId}
          onChange={event => setStaffingPositionId(event.target.value)}>
          <option value="">Выберите должность</option>
          {positions.map(position => <option key={position.id} value={position.id}>
            {position.name}
          </option>)}
        </Select> : <input
          required
          minLength={2}
          maxLength={120}
          value={staffingPositionName}
          onChange={event => setStaffingPositionName(event.target.value)}
          placeholder="Например, бариста" />}
      </label>}
      <label>
        <span>Комментарий{type?.requiresComment ? ' *' : ''}</span>
        <textarea
          rows={3}
          maxLength={type?.systemCode === 'SICK' ? 500 : 2000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          required={type?.requiresComment}
          placeholder="Опишите детали заявки" />
      </label>
      {type?.allowsAttachments && <FilePicker
        label="Вложения"
        value={files}
        onChange={setFiles}
        multiple
        accept="application/pdf,image/jpeg,image/png,image/webp"
        maxFiles={Math.max(0, 5 - (request?.attachments.length ?? 0))}
        maxBytes={10 * 1024 * 1024}
        disabled={busy}
        hint="До 5 файлов на заявку, каждый не больше 10 МБ. PDF, JPEG, PNG или WebP." />}
      {request && request.attachments.length > 0 && <p className="request-form-note">Вложений сейчас: {request.attachments.length}. Удалить существующие можно в карточке заявки.</p>}
      <OperationStatus state={busy ? {
        phase: 'running',
        message: savedId && files.length ? 'Заявка сохранена. Вложения: ' + uploaded.length + ' из ' + files.length + '.' : 'Сохраняем заявку…'
      } : error ? {
        phase: 'failed',
        message: error
      } : null} />
      <footer>
        <button
          type="button"
          className="app-secondary"
          disabled={busy}
          onClick={() => void safety.close(onClose)}>Отмена</button>
        <button className="app-primary" disabled={busy || !type}>
          {busy ? 'Сохраняем…' : type?.systemCode === 'SICK' ? request ? 'Сохранить сообщение' : 'Сообщить об отсутствии' : request ? 'Сохранить изменения' : 'Отправить заявку'}
        </button>
      </footer>
    </form>
  </DocumentDialog>
}
