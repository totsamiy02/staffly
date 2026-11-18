import RequestIcon from './request-icon.tsx'
import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import ActionSurface from '../../../component/ui/action-surface.tsx'
import MemberProfileLink from '../../../component/ui/member-profile-link.tsx'
import { locationTone } from '../../../app/organizations/format.ts'
import { absenceDays } from '../../../app/schedule/absence-format.ts'
import type { StaffRequest } from '../../../app/requests/types.ts'
import DocumentActionsMenu from '../documents/document-actions-menu.tsx'
import { shiftWindow, requestStatusLabel, periodLabel } from './request-format.ts'

export default function RequestCard({ request, incoming, timezone, onOpen }: { request: StaffRequest; incoming: boolean; timezone: string; onOpen: () => void }) {
  const unread = incoming && request.status === 'PENDING' && !request.readByViewer
  const shift = ['SHIFT_CHANGE', 'SHIFT_PROPOSAL'].includes(request.systemCodeSnapshot ?? '')
  const original = request.originalStartAt && request.originalEndAt ? shiftWindow(request.originalStartAt, request.originalEndAt, timezone) : 'Исходная смена не указана'
  const proposed = request.proposedStartAt && request.proposedEndAt ? shiftWindow(request.proposedStartAt, request.proposedEndAt, timezone) : 'Новое время не указано'
  return <div className="request-table-item">
    <ActionSurface
      type="button"
      className={`request-card request-row${unread ? ' request-card--unread' : ''}`}
      onClick={onOpen}
      aria-label={`${request.creatorName}, ${request.typeNameSnapshot}, ${requestStatusLabel(request)}`}>
      <span className="request-row__person">
        <MemberAvatar
          memberId={request.createdByMemberId}
          locationId={request.locationId}
          url={request.creatorAvatarUrl}
          name={request.creatorName}
          className="app-avatar" />
        <span>
          <strong>
            <MemberProfileLink memberId={request.createdByMemberId} locationId={request.locationId}>
              {request.creatorName}
            </MemberProfileLink>
          </strong>
          <small>
            {request.creatorEmail}
          </small>
        </span>
        {unread && <i
          className="request-unread"
          role="img"
          aria-label="Не прочитана" />}
      </span>
      <span className="request-row__type">
        <span className="request-type-label">
          {request.typeNameSnapshot}
        </span>
        <small className="location-badge" data-tone={locationTone(request.locationId ?? '')}>⌖ {request.locationName}</small>
        {request.staffingPositionName && <small>
          {request.staffingPositionName}
        </small>}
      </span>
      <span className="request-row__period">
        <strong>
          {shift ? proposed : periodLabel(request)}
        </strong>
        {request.systemCodeSnapshot === 'SHIFT_CHANGE' && <small>Исходная: {original}</small>}
        {request.systemCodeSnapshot === 'DAY_OFF' && request.relatedShiftId && <small>Смена: {original}</small>}
        {request.comment && <small className="request-card__comment">
          {request.comment}
        </small>}
      </span>
      <span className="request-row__duration">
        {request.startDate ? `${absenceDays(request.startDate, request.endDate ?? request.startDate)} дн.` : '—'}
      </span>
      <span className={`request-status request-status--${request.status.toLowerCase()}`}>
        {requestStatusLabel(request)}
      </span>
      <time dateTime={request.createdAt}>
        {new Date(request.createdAt).toLocaleDateString('ru-RU')}
      </time>
    </ActionSurface>
    <DocumentActionsMenu label={`Действия заявки ${request.typeNameSnapshot}`}>
      <button onClick={onOpen}><RequestIcon code={request.systemCodeSnapshot} />Открыть заявку</button>
    </DocumentActionsMenu>
  </div>
}
