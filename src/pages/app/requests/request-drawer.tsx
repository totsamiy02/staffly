import RequestAssignment from './reviewer-transfer.tsx'
import { openingHoursConfirmationFrom } from '../../../shared/organization-profile.ts'
import OpeningHoursWarning from '../organizations/opening-hours-warning.tsx'
import ConfirmationDialog from '../../../component/ui/modal/confirmation-dialog.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import RequestIcon from './request-icon.tsx'
import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import MemberProfileLink from '../../../component/ui/member-profile-link.tsx'
import VacationBalancePreview from './vacations/vacation-balance-card.tsx'
import RequestOperations from './request-operations.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import { useToast, useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import { absenceDays, absenceNames } from '../../../app/schedule/absence-format.ts'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import RoleBadge from '../../../component/ui/role-badge/role-badge.tsx'
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { displayDate, formatTime, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useRequestDetail } from '../../../app/requests/queries.ts'
import type { StaffRequest, RequestMutationResponse } from '../../../app/requests/types.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import './requests.scss'
import './requests-redesign.scss'
import { shiftWindow, requestStatusLabel, absenceReasonLabels, periodLabel } from './request-format.ts'
import RequestAttachments from './request-attachments.tsx'

function transferredReview(event: StaffRequest['events'][number]) {
  return event.type === 'CHANGED' && event.changes && typeof event.changes === 'object'
    && !Array.isArray(event.changes) && event.changes.action === 'REVIEWER_TRANSFERRED'
}

const eventLabels = {
  SUBMITTED: 'Обращение отправлено',
  RETURNED: 'Возвращено на доработку',
  CHANGED: 'Действующие условия изменены',
  STAGE_APPROVED: 'Этап согласован',
  EXPIRED: 'Срок истёк',
  INVALID: 'Условия изменились',
  CREATED: 'Заявка отправлена',
  EDITED: 'Заявка изменена',
  APPROVED: 'Заявка одобрена',
  REJECTED: 'Заявка отклонена',
  CANCELLED: 'Заявка отменена'
} as const

export function RequestDrawer({ organization, requestId, scope, onEdit, onClose }: { organization: OrganizationSummary; requestId: string; scope: 'mine' | 'incoming' | 'history' | 'staffing'; onEdit: (request: StaffRequest) => void; onClose: () => void }) {
  const toast = useToast()
  const { apiRequest, user } = useAuth()
  const queryClient = useQueryClient()
  const detail = useRequestDetail(organization.id, requestId)
  const [comment, setComment] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewKind, setReviewKind] = useState<'approve' | 'reject'>('approve')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [confirmConflicts, setConfirmConflicts] = useState(false)
  const [openingWarning, setOpeningWarning] = useState<string>(), [outsideAccepted, setOutsideAccepted] = useState(false)
  useEffect(() => {
    setOpeningWarning(undefined)
    setOutsideAccepted(false)
  }, [requestId, detail.data?.request.updatedAt])
  const [acknowledgeWorkload, setAcknowledgeWorkload] = useState(false)
  const [absenceWarning, setAbsenceWarning] = useState(false)
  const [acknowledgeAbsence, setAcknowledgeAbsence] = useState(false)
  const [workloadWarning, setWorkloadWarning] = useState(false)
  const [error, setError] = useState('')
  useToastFeedback('', error)
  const request = detail.isSuccess ? detail.data.request : undefined
  const conflicts = detail.data?.conflicts ?? []
  const reviewer = canAccess(organization, 'requests.view')
  const own = request?.isOwn ?? request?.creatorEmail === user?.email
  useEffect(() => {
    if (detail.data && reviewer && scope === 'incoming') void queryClient.invalidateQueries({ queryKey: ['requests', organization.id] })
  }, [detail.data, organization.id, queryClient, reviewer, scope])
  const refresh = () => invalidateOrganizationWork(queryClient, organization.id)
  const decision = useMutation({
    mutationFn: (kind: 'approve' | 'reject') => apiRequest<RequestMutationResponse>(`/organizations/${organization.id}/requests/${requestId}/${kind}`, {
      method: 'POST',
      body: kind === 'approve' ? {
        openingHoursConfirmation: outsideAccepted ? openingWarning : undefined,
        comment: comment || null,
        cancelConflictingShifts: confirmConflicts,
        acknowledgeWorkload,
        acknowledgeAbsence
      } : { comment }
    }),
    onSuccess: async (_result, kind) => {
      reviewSafety.markSaved()
      setComment('')
      toast(_result.request.status === 'PENDING' ? 'Этап согласован. Обращение передано дальше.' : kind === 'approve' ? 'Заявка одобрена' : 'Заявка отклонена', 'success')
      setReviewOpen(false)
      await refresh()
    },
    onError: (failure) => {
      const token = openingHoursConfirmationFrom(failure)
      if (token) {
        setOpeningWarning(token)
        setOutsideAccepted(false)
      }
      if ((failure as { code?: string }).code === 'EMPLOYEE_ABSENT') setAbsenceWarning(true)
      if ((failure as { code?: string }).code === 'WORKLOAD_WARNING') setWorkloadWarning(true)
      setError(failure instanceof Error ? failure.message : 'Не удалось обработать заявку.')
    }
  })
  const respond = useMutation({
    mutationFn: () => apiRequest(`/organizations/${organization.id}/requests/${requestId}/respond`, {
      method: 'POST',
      body: { comment }
    }),
    onSuccess: async () => {
      reviewSafety.markSaved()
      setComment('')
      toast('Отклик отправлен. Подтверждение придёт в уведомлениях.')
      await refresh()
    },
    onError: (failure) => setError(failure.message)
  })
  const cancel = useMutation({
    mutationFn: () => apiRequest(`/organizations/${organization.id}/requests/${requestId}/cancel`, {
      method: 'POST',
      body: {}
    }),
    onSuccess: async () => {
      reviewSafety.markSaved()
      setComment('')
      toast('Заявка отменена', 'success')
      setCancelOpen(false)
      await refresh()
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Не удалось отменить заявку.')
  })
  const reviewSafety = useFormSafety({
    scope: 'request-review:' + organization.id + ':' + requestId,
    value: {},
    dirty: !!comment,
    busy: decision.isPending || respond.isPending || cancel.isPending,
    onDiscard: () => setComment('')
  })
  const canDecide = request?.status === 'PENDING' && request.canReview && scope === 'incoming'
    && canAccess(organization, request.systemCodeSnapshot === 'VACATION' ? 'vacations.resolve' : ['STAFFING', 'STAFFING_RESPONSE'].includes(request.systemCodeSnapshot ?? '') ? 'staffing.resolve' : 'requests.resolve')
  const canOpenIncoming = request?.status === 'PENDING' && own && reviewer && scope === 'mine'
  const canEditOwnRequest = request && own && canAccess(organization, 'requests.edit')
    && (request.status === 'PENDING' || request.systemCodeSnapshot === 'SICK' && ['REGISTERED', 'APPROVED'].includes(request.status))
  const showClosedNotice = request?.systemCodeSnapshot === 'SICK' && !['PENDING', 'REGISTERED', 'APPROVED'].includes(request.status)
  const showActions = canDecide || canOpenIncoming || canEditOwnRequest || showClosedNotice

  return <DocumentDialog
    formRef={reviewSafety.ref}
    className="request-detail-dialog"
    title="Заявка"
    eyebrow="Заявки"
    onClose={onClose}
    headerContent={request ? <></> : undefined}>
    {detail.isLoading ? <div className="app-state">
      <span className="app-spinner" />
    </div> : detail.isError || !request ? <div className="app-state">
      <p>Не удалось открыть заявку.</p>
      <button className="app-secondary" onClick={() => void detail.refetch()}>Повторить</button>
    </div> : <>
      <header>
        <div>
          <p className="app-eyebrow">Заявка</p>
          <h2>Заявка · {request.typeNameSnapshot}</h2>
          <span className={`request-status request-status--${request.status.toLowerCase()}`}>
            {requestStatusLabel(request)}
          </span>
        </div>
        <button aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <div className="request-summary-card">
        <section className="request-detail-person">
          <MemberAvatar
            memberId={request.createdByMemberId}
            locationId={request.locationId}
            url={request.creatorAvatarUrl}
            name={request.creatorName}
            className="app-avatar" />
          <div>
            <MemberProfileLink memberId={request.createdByMemberId} locationId={request.locationId}>
              <strong>
                {request.creatorName}
              </strong>
            </MemberProfileLink>
            <span><RoleBadge role={request.creatorRole} name={request.creatorRoleName} /> · {request.creatorEmail}</span>
            <span className="request-type-label">
              <RequestIcon code={request.systemCodeSnapshot} />
              {request.typeNameSnapshot}
            </span>
            {request.startDate && <span className="request-summary-period">{periodLabel(request)} · {absenceDays(request.startDate, request.endDate ?? request.startDate)} дн.</span>}
          </div>
        </section>
        <dl className="request-detail-grid">
          <div>
            <dt>Отправлена</dt>
            <dd>
              {new Date(request.createdAt).toLocaleString('ru-RU')}
            </dd>
          </div>
          <div>
            <dt>Просмотрена</dt>
            <dd>
              {request.firstReadAt ? new Date(request.firstReadAt).toLocaleString('ru-RU') : 'Ещё не просмотрена'}
            </dd>
          </div>
          {request.resolvedByName && <div>
            <dt>Решение принял</dt>
            <dd>
              {request.resolvedByMemberId ? <MemberProfileLink memberId={request.resolvedByMemberId} locationId={request.locationId}>
                {request.resolvedByName}
              </MemberProfileLink> : request.resolvedByName}
            </dd>
          </div>}
        </dl>
      </div>
      <div className={`request-detail-layout${!showActions ? ' request-detail-layout--closed' : ''}`}>
        <div className="request-detail-main">
          {request.systemCodeSnapshot === 'SICK_LEAVE' && request.status === 'PENDING' && <p className="absence-note">Старая заявка на больничный. Теперь болезнь сообщается без согласования через «Сообщить об отсутствии». Эту заявку можно отменить; её история сохранится.</p>}
          {request.systemCodeSnapshot === 'SICK' && request.absenceReason && <section className="request-detail-block">
            <h3>Причина отсутствия</h3>
            <p>
              {absenceReasonLabels[request.absenceReason]}
            </p>
            <p>Сообщение зарегистрировано без согласования.</p>
          </section>}
          <RequestAssignment request={request} onTransferred={onClose} />
          <RequestOperations
            organization={organization}
            request={request}
            onEdit={() => void reviewSafety.close(() => onEdit(request))} />
          {request.comment && <section className="request-detail-block">
            <h3>Комментарий</h3>
            <p>
              {request.comment}
            </p>
          </section>}
          {(request.relatedShiftId || ['SHIFT_PROPOSAL', 'STAFFING', 'STAFFING_RESPONSE'].includes(request.systemCodeSnapshot ?? '')) && <section className="request-detail-block">
            <h3>
              {['STAFFING', 'STAFFING_RESPONSE'].includes(request.systemCodeSnapshot ?? '') ? `Подмена · ${request.staffingPositionName}` : request.systemCodeSnapshot === 'DAY_OFF' ? 'Смена для отгула' : request.systemCodeSnapshot === 'SHIFT_PROPOSAL' ? 'Предлагаемая смена' : 'Исходная смена → Запрошенное изменение'}
            </h3>
            {request.originalStartAt && request.originalEndAt && <p className="request-shift-original">
              <strong>Исходная смена</strong>
              <br />
              {" "}
              {shiftWindow(request.originalStartAt, request.originalEndAt, organization.timezone)}
            </p>}
            {request.systemCodeSnapshot !== 'DAY_OFF' && (request.proposedStartAt && request.proposedEndAt ? <p className="request-shift-requested">
              <strong>Запрошенное время</strong>
              <br />
              {" "}
              {shiftWindow(request.proposedStartAt, request.proposedEndAt, organization.timezone)}
            </p> : <p>В этой заявке не указано новое время. Для переноса подайте новую заявку.</p>)}
            {request.relatedShiftId && <Link className="request-related-shift" to={`/app/organizations/${organization.id}/schedule?location=${request.locationId ?? organization.locationId ?? ''}&month=${zonedDateAndTime((request.status === 'APPROVED' ? request.proposedStartAt : request.originalStartAt) ?? request.createdAt, organization.timezone).date.slice(0, 7)}&shift=${request.relatedShiftId}&returnRequest=${request.id}&returnTab=${scope}`}>Открыть смену в календаре</Link>}
          </section>}
          {(request.attachments.length > 0 || request.events.some(event => event.comment?.startsWith('Удалён файл: '))) && <RequestAttachments
            events={request.events}
            attachments={request.attachments}
            canRemove={Boolean((own || request.isAuthor && canAccess(organization, 'requests.onBehalf')) && scope === 'mine' && ['PENDING', 'DRAFT', 'RETURNED'].includes(request.status) && canAccess(organization, 'requests.edit'))}
            organizationId={organization.id}
            requestId={requestId} />}
          {!!detail.data?.absenceConflicts?.length && <section className="request-conflicts">
            <h3>Пересечение с другим отсутствием</h3>
            <p>В эти даты уже зарегистрировано отсутствие. Перед одобрением скорректируйте период заявки или существующее отсутствие.</p>
            {detail.data.absenceConflicts.map(item => <Link key={item.id} to={`/app/organizations/${organization.id}/schedule?location=${request.locationId ?? organization.locationId ?? ''}&absences=1&absence=${item.id}`}>{absenceNames[item.type]} · {displayDate(item.startDate)} — {displayDate(item.endDate)}</Link>)}
          </section>}
          {!!detail.data?.otherAbsentEmployees && <p className="absence-note">Других сотрудников с отсутствием в этом периоде: {detail.data.otherAbsentEmployees}</p>}
          {conflicts.length > 0 && <section className="request-conflicts">
            <h3>Смены в период отсутствия</h3>
            <p>В периоде назначено смен: {conflicts.length}. {request.status === 'PENDING' ? 'При одобрении они останутся в расписании, если вы явно не подтвердите отмену.' : 'Назначенные смены можно проверить и изменить в расписании.'}</p>
            {conflicts.map((shift) => <div key={shift.id}>
              <Link to={`/app/organizations/${organization.id}/schedule?location=${shift.locationId ?? request.locationId ?? organization.locationId ?? ''}&month=${zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date.slice(0, 7)}&shift=${shift.id}&returnRequest=${request.id}&returnTab=${scope}`}>
                <strong>
                  {displayDate(zonedDateAndTime(shift.scheduledStartAt, organization.timezone).date)}
                </strong>
                <span>{formatTime(shift.scheduledStartAt, organization.timezone)}–{formatTime(shift.scheduledEndAt, organization.timezone)}</span>
              </Link>
            </div>)}
          </section>}
          {request.systemCodeSnapshot === 'STAFFING' && <section className="request-detail-block">
            <h3>Отклики</h3>
            {detail.data?.viewerCanRespond && <>
              <label>
                <span>Комментарий к отклику · необязательно</span>
                <textarea
                  rows={2}
                  value={comment}
                  maxLength={2000}
                  onChange={event => setComment(event.target.value)} />
              </label>
              <button
                className="app-primary"
                disabled={respond.isPending}
                onClick={() => respond.mutate()}>Могу выйти на подмену</button>
            </>}
            {detail.data?.viewerResponseId && <Link className="app-secondary" to={`?location=${request.locationId}&tab=mine&request=${detail.data.viewerResponseId}`}>Мой отклик</Link>}
            {detail.data?.staffingResponses?.map(response => <Link
              className="staffing-response"
              key={response.id}
              to={`?location=${request.locationId}&tab=incoming&request=${response.id}`}>
              <Avatar
                url={response.creatorAvatarUrl}
                name={response.creatorName}
                className="app-avatar" />
              <span>
                {response.creatorName}
                <small>
                  {requestStatusLabel(response)}
                </small>
              </span>
            </Link>)}
            {!detail.data?.viewerCanRespond && !detail.data?.viewerResponseId && !detail.data?.staffingResponses?.length && <p>
              {request.status === 'PENDING' ? 'Откликов пока нет. Заявка доступна сотрудникам других точек.' : 'Заявка закрыта.'}
            </p>}
          </section>}
          {request.resolutionComment && <section className="request-detail-block">
            <h3>
              {request.status === 'REJECTED' ? 'Причина отклонения' : 'Комментарий к решению'}
            </h3>
            <p>
              {request.resolutionComment}
            </p>
          </section>}
          <section className="request-timeline">
            <h3>Ход заявки</h3>
            {request.events.map((event) => <div key={event.id}>
              <i />
              <div className="request-timeline__entry">
                <strong>
                  {transferredReview(event) ? 'Согласование передано' : eventLabels[event.type]}
                </strong>
                <span><MemberProfileLink memberId={event.actorMemberId} locationId={request.locationId}>
                  {event.actorName}
                </MemberProfileLink> · {new Date(event.createdAt).toLocaleString('ru-RU')}</span>
                {event.comment && <small>
                  {event.comment}
                </small>}
                {event.changes != null && !transferredReview(event) && <details>
                  <summary>Изменения</summary>
                  <HistoryChanges value={event.changes} />
                </details>}
              </div>
            </div>)}
          </section>
          {error && <p className="form-inline-error">
            {error}
          </p>}
        </div>
        {showActions && <aside className="request-detail-actions">
          <h3>Действия</h3>
          {canDecide && <button className="app-primary" onClick={() => setReviewOpen(true)}><RequestIcon />Рассмотреть заявку</button>}
          {canOpenIncoming && <Link className="request-related-shift" to={`?tab=incoming&request=${request.id}`}>Открыть во вкладке «На рассмотрении»</Link>}
          {canEditOwnRequest && <div className="request-own-actions">
            {!['STAFFING', 'STAFFING_RESPONSE'].includes(request.systemCodeSnapshot ?? '') && <button className="app-secondary" onClick={() => void reviewSafety.close(() => onEdit(request))}>Изменить заявку</button>}
            <button
              className="request-cancel"
              disabled={cancel.isPending}
              onClick={() => setCancelOpen(true)}>Отменить заявку</button>
          </div>}
          {!(request.status === 'PENDING' || (request.systemCodeSnapshot === 'SICK' && ['REGISTERED', 'APPROVED'].includes(request.status))) && <p>Заявка закрыта. Решение и история сохранены.</p>}
        </aside>}
      </div>
      {reviewOpen && <AnimatedOverlay
        variant="modal"
        dismissible={!decision.isPending}
        onClose={() => setReviewOpen(false)}>
        {close => <DocumentDialog
          title="Рассмотреть заявку"
          className="request-review-dialog"
          eyebrow="Заявки"
          busy={decision.isPending}
          onClose={close}
          onEscape={close}>
          <div className="request-review-person">
            <MemberAvatar
              memberId={request.createdByMemberId}
              locationId={request.locationId}
              url={request.creatorAvatarUrl}
              name={request.creatorName}
              className="app-avatar" />
            <span>
              <MemberProfileLink memberId={request.createdByMemberId} locationId={request.locationId}>
                <strong>
                  {request.creatorName}
                </strong>
              </MemberProfileLink>
              <small>{request.typeNameSnapshot} · {periodLabel(request)}</small>
            </span>
          </div>
          <section className="request-review">
            {request.systemCodeSnapshot === 'VACATION' && <VacationBalancePreview
              organization={organization}
              memberId={request.createdByMemberId}
              startDate={request.startDate ?? ''}
              endDate={request.endDate ?? ''}
              requestId={request.id} />}
            {openingWarning && <OpeningHoursWarning
              className="request-review__confirm"
              checked={outsideAccepted}
              onChange={setOutsideAccepted} />}
            {absenceWarning && <label className="request-review__confirm">
              <input
                type="checkbox"
                checked={acknowledgeAbsence}
                onChange={event => setAcknowledgeAbsence(event.target.checked)} />
              <span>Подтверждаю назначение смены в период отсутствия</span>
            </label>}
            {workloadWarning && <label className="request-review__confirm">
              <input
                type="checkbox"
                checked={acknowledgeWorkload}
                onChange={event => setAcknowledgeWorkload(event.target.checked)} />
              <span>Подтверждаю превышение месячной нормы</span>
            </label>}
            <label>
              <span>Комментарий к решению</span>
              <textarea
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Для отклонения причина обязательна" />
            </label>
            {conflicts.length > 0 && <label className="request-review__confirm">
              <input
                type="checkbox"
                checked={confirmConflicts}
                onChange={(event) => setConfirmConflicts(event.target.checked)} />
              <span>Отменить пересекающиеся будущие смены при одобрении</span>
            </label>}
            <fieldset className="request-decision-choice">
              <legend>Ваше решение</legend>
              <label><input
                type="radio"
                name="request-decision"
                checked={reviewKind === 'approve'}
                onChange={() => setReviewKind('approve')}
                disabled={decision.isPending || (request.systemCodeSnapshot === 'SHIFT_CHANGE' && !request.proposedStartAt) || request.systemCodeSnapshot === 'SICK_LEAVE' || request.systemCodeSnapshot === 'STAFFING'} />Одобрить</label>
              <label><input
                type="radio"
                name="request-decision"
                checked={reviewKind === 'reject'}
                onChange={() => setReviewKind('reject')}
                disabled={decision.isPending} />Отклонить</label>
            </fieldset>
            <div>
              <button
                className="app-secondary"
                disabled={decision.isPending}
                onClick={close}>Назад</button>
              <button
                className={reviewKind === 'reject' ? 'app-danger' : 'app-primary'}
                disabled={decision.isPending || (reviewKind === 'approve' && !!openingWarning && !outsideAccepted) || (reviewKind === 'reject' ? comment.trim().length < 3 : (request.systemCodeSnapshot === 'SHIFT_CHANGE' && !request.proposedStartAt) || request.systemCodeSnapshot === 'SICK_LEAVE' || request.systemCodeSnapshot === 'STAFFING')}
                onClick={() => decision.mutate(reviewKind)}>
                {decision.isPending ? 'Сохраняем…' : 'Сохранить решение'}
              </button>
            </div>
            {error && <p className="form-inline-error" role="alert">
              {error}
            </p>}
          </section>
        </DocumentDialog>}
      </AnimatedOverlay>}
      {cancelOpen && <AnimatedOverlay
        variant="modal"
        dismissible={!cancel.isPending}
        onClose={() => setCancelOpen(false)}>
        {close => <ConfirmationDialog
          title="Отменить заявку?"
          eyebrow="Заявки"
          busy={cancel.isPending}
          onClose={close}
          description="Заявка останется в истории. Связанное отсутствие будет обновлено."
          error={error}
          confirmLabel="Отменить заявку"
          pendingLabel="Отменяем…"
          onConfirm={() => cancel.mutate()} />}
      </AnimatedOverlay>}
    </>}
  </DocumentDialog>
}

function HistoryChanges({ value }: { value: unknown }) {
  const change = value as { before?: Record<string, unknown>; after?: Record<string, unknown>; automatic?: boolean; employeeConsent?: boolean }
  const names: Record<string, string> = {
    startDate: 'Первый день',
    endDate: 'Последний день',
    comment: 'Комментарий',
    reason: 'Причина',
    proposedStartAt: 'Начало смены',
    proposedEndAt: 'Окончание смены',
    cancelled: 'Отмена'
  }
  return <div>
    {Object.entries(names).filter(([k]) => change.before?.[k] !== change.after?.[k] && (change.before?.[k] !== undefined || change.after?.[k] !== undefined)).map(([k, label]) => <p key={k}>{label}: {String(change.before?.[k] ?? '—')} → {String(change.after?.[k] ?? '—')}</p>)}
    {change.employeeConsent && <p>Согласие сотрудника зафиксировано.</p>}
    {change.automatic && <p>Действие выполнено системой.</p>}
  </div>
}
