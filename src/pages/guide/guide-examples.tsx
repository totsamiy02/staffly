import ScheduleAgenda from '../app/schedule/schedule-agenda.tsx'
import WorkTimePanel from '../app/schedule/work-time-panel.tsx'
import { OfferShiftCard } from '../app/schedule/offer-shift-card.tsx'
import DocumentRow from '../app/documents/document-row.tsx'
import { EventRowContent } from '../app/events/event-elements.tsx'
import { ReportRules } from '../app/schedule/report-ui.tsx'
import type { WorkShift, MemberWorkTime } from '../../app/schedule/types.ts'
import type { OfferShift } from '../../app/schedule/offers.ts'
import type { DocumentItem } from '../../app/documents/types.ts'
import type { StaffEvent } from '../../app/events/types.ts'
import type { GuideExampleId } from './content/types.ts'
import { guideExampleLabels } from './guide-example-labels.ts'
import '../app/schedule/schedule.scss'
import '../app/schedule/schedule-redesign.scss'
import '../app/schedule/reporting.scss'
import '../app/documents/documents.scss'

const noop = () => {}
const shift: WorkShift = {
  id: 'example-shift', memberId: 'example-member', memberName: 'Анна Смирнова',
  positionName: 'Администратор зала', scheduledStartAt: '2026-10-19T06:00:00Z', scheduledEndAt: '2026-10-19T15:00:00Z',
  breakMinutes: 30, actualStartAt: null, actualEndAt: null, actualBreakMinutes: null,
  effectiveMinutes: 540, description: null, status: 'SCHEDULED', cancelledAt: null, cancellationReason: null, adjusted: false,
}
const offerShift: OfferShift = { id: shift.id, memberId: shift.memberId, locationId: 'example-point', startAt: shift.scheduledStartAt, endAt: shift.scheduledEndAt, timezone: 'Europe/Moscow', positionId: null, positionName: shift.positionName ?? null, breakMinutes: 30, description: null }
const workTime: MemberWorkTime = {
  member: { id: 'example-member', name: 'Анна Смирнова', avatarUrl: null, role: 'MEMBER', active: true },
  period: { memberId: 'example-member', userId: 'example-user', name: 'Анна Смирнова', avatarUrl: null, role: 'MEMBER', active: true, joinedAt: '2026-09-01', leftAt: null, workedMinutes: 4320, workedShifts: 8, averageMinutes: 540, plannedMinutes: 2160, plannedShifts: 4 },
  allTime: null,
  history: [{ ...shift, scheduledStartAt: '2026-10-05T06:00:00Z', scheduledEndAt: '2026-10-05T15:00:00Z', minutes: 540, plannedMinutes: 540, actualMinutes: null }],
  pagination: { page: 1, limit: 10, total: 1, pages: 1 }, timezone: 'Europe/Moscow',
}
workTime.allTime = workTime.period
const document: DocumentItem = {
  id: 'example-document', organizationId: 'example', folderId: null, displayName: 'Правила работы команды', fileName: 'Правила работы.pdf', visibility: 'ORGANIZATION', targetMemberId: null,
  createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', deletedAt: null, mimeType: 'application/pdf', size: 245760, previewable: true,
  uploadedBy: { name: 'Михаил Орлов', avatarUrl: null }, targetMember: null,
  acknowledgement: { id: 'example-ack', assignedBy: null, assignedAt: '2026-10-01T09:00:00Z', openedAt: null, acknowledgedAt: null, cancelledAt: null, deadline: null, comment: null, state: 'UNOPENED', overdue: false },
}
const event: StaffEvent = {
  id: 'example-event', organizationId: 'example', title: 'Встреча команды', description: null, typeLabel: 'Планёрка',
  startAt: '2026-10-19T07:00:00Z', endAt: '2026-10-19T07:30:00Z', timezone: 'Europe/Moscow', place: 'Переговорная', meetingUrl: null,
  shared: true, locations: [], audienceMode: 'ALL', audienceRoles: [], recipients: [], recipientCount: 8, isRecipient: true,
  createdBy: { id: 'example-author', name: 'Михаил Орлов' }, updatedBy: { id: 'example-author', name: 'Михаил Орлов' },
  revision: 1, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', cancelledAt: null, status: 'UPCOMING', canManage: false,
}


/** Actual presentational components, with local fictional data. No API, auth, or organization context. */
export default function GuideExample({ example }: { example: GuideExampleId }) {
  return <div className="guide-example" role="img" aria-label={`${guideExampleLabels[example]}. Пример интерфейса с вымышленными данными.`}><div inert>
    {example === 'schedule' && <ScheduleAgenda days={['2026-10-19']} shifts={[shift, { ...shift, id: 'example-shift-two', memberName: 'Дмитрий Волков', positionName: 'Бариста', scheduledStartAt: '2026-10-19T09:00:00Z', scheduledEndAt: '2026-10-19T18:00:00Z' }]} timezone="Europe/Moscow" onShift={noop} />}
    {example === 'transfer' && <OfferShiftCard shift={offerShift} locationName="Центральная" />}
    {example === 'offers' && <div className="offer-comparison"><OfferShiftCard shift={offerShift} locationName="Центральная" label="Вы отдаёте" tone="out" /><span className="offer-comparison__arrow" aria-hidden="true">⇄</span><OfferShiftCard shift={{ ...offerShift, id: 'example-other', startAt: '2026-10-20T06:00:00Z', endAt: '2026-10-20T15:00:00Z' }} locationName="Центральная" label="Вы получаете" tone="in" /></div>}
    {example === 'time' && <WorkTimePanel data={workTime} />}
    {example === 'documents' && <DocumentRow item={document} onOpen={noop} acknowledgementHighlight />}
    {example === 'events' && <div className="event-row"><EventRowContent event={event} /></div>}
    {example === 'reports' && <div className="report-dialog document-dialog"><ReportRules /></div>}
  </div></div>
}
