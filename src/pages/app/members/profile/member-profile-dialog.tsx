import { AccessIcon } from '../../settings/access/access-elements.tsx'
import AsyncPanel from '../../../../component/ui/async-panel.tsx'
import ShiftDetailsDialog from '../../schedule/time/shift-details-dialog.tsx'
import { accountedTimeLabel } from '../../../../app/schedule/time/time-correction.ts'
import TimeCorrectionAction from '../../schedule/time/time-correction-action.tsx'
import { MemberPositions } from '../organization-members.tsx'
import { MemberAccessDialog } from '../../settings/access/access-settings.tsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useMemberProfileData } from '../../../../app/member-profile/queries.ts'
import type { ProfileSection } from '../../../../app/member-profile/types.ts'
import { useLocations } from '../../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import type { ShiftDetails } from '../../../../app/schedule/types.ts'
import { formatDuration, formatTime, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import Avatar from '../../../../component/ui/avatar/avatar.tsx'
import RoleBadge from '../../../../component/ui/role-badge/role-badge.tsx'
import Select from '../../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import MonthPicker from '../../../../component/ui/month-picker/month-picker.tsx'
import ModuleIcon from '../../../../component/ui/module-icon.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import DocumentDrawer from '../../documents/document-drawer.tsx'
import { ProfileAbout, ProfileWorkplaces, ProfileMetrics, ProfileUpcoming, ProfileEmpty } from './member-profile-summary.tsx'
import { profileDate } from '../../../../app/member-profile/presentation.ts'
import './member-profile.scss'

const sectionLabels: Record<ProfileSection, string> = { overview: 'Обзор', time: 'Рабочее время', documents: 'Документы', requests: 'Заявки' }
const requestLabels: Record<string, string> = { DRAFT: 'Черновик', RETURNED: 'Возвращена', PENDING: 'На рассмотрении', REGISTERED: 'Зарегистрирована', APPROVED: 'Согласована', REJECTED: 'Отклонена', CANCELLED: 'Отменена', EXPIRED: 'Срок истёк', INVALID: 'Неактуальна' }
const absenceLabels: Record<string, string> = { VACATION: 'Отпуск', DAY_OFF: 'Выходной', SICK: 'Отсутствие', SICK_LEAVE: 'Больничный', ABSENCE: 'Отсутствие' }
function dateLabel(value: string, timezone?: string) { return new Date(value).toLocaleDateString('ru-RU', { ...(timezone ? { timeZone: timezone } : { timeZone: 'UTC' }), day: 'numeric', month: 'long' }) }
function Pager({ page, pages, change }: { page: number; pages: number; change: (page: number) => void }) { return pages > 1 ? <div className="member-profile-pagination"><button className="app-secondary" disabled={page <= 1} onClick={() => change(page - 1)}>Назад</button><span>{page} / {pages}</span><button className="app-secondary" disabled={page >= pages} onClick={() => change(page + 1)}>Далее</button></div> : null }
export default function MemberProfileDialog({ organization, memberId, initialLocationId, initialSection, onClose }: { organization: OrganizationSummary; memberId: string; initialLocationId: string; initialSection: ProfileSection; onClose: () => void }) {
  // A direct Documents entry first discovers the allowed document kind in the public overview.
  const [section, setSection] = useState<ProfileSection>(initialSection === 'documents' ? 'overview' : initialSection), [pointId, setPointId] = useState(initialLocationId), [month, setMonth] = useState(zonedDateAndTime(new Date().toISOString(), organization.timezone).date.slice(0, 7)), [page, setPage] = useState(1)
  const [kind, setKind] = useState<'personal' | 'acknowledgements'>('personal'), [requestState, setRequestState] = useState<'all' | 'pending'>('all'), [manage, setManage] = useState<'positions' | 'access' | null>(null)
  const [documentId, setDocumentId] = useState<string | null>(null), [shiftId, setShiftId] = useState<string | null>(null), [shiftPage, setShiftPage] = useState(1)
  const workspace = useRef<HTMLDivElement | null>(null)
  const activeTab = useRef<HTMLButtonElement | null>(null), restoreTabFocus = useRef(false)
  const managementTrigger = useRef<HTMLButtonElement | null>(null), managementWasOpen = useRef(false)
  useEffect(() => {
    if (manage) managementWasOpen.current = true
    else if (managementWasOpen.current) {
      managementWasOpen.current = false
      // MemberPositions also restores its directory trigger. Keep nested profile focus in this window.
      if (managementTrigger.current?.isConnected) managementTrigger.current.focus()
      else activeTab.current?.focus()
    }
  }, [manage])
  const query = useMemberProfileData(organization.id, memberId, { month, locationId: pointId, section, page, kind, requestState }), points = useLocations(organization.id)
  const { apiRequest } = useAuth(), navigate = useNavigate()
  const data = query.data, member = data?.member
  const entryApplied = useRef(false)
  useEffect(() => {
    if (entryApplied.current || !data || query.isPlaceholderData) return
    entryApplied.current = true
    if (initialSection === 'documents' && data.capabilities.documents) {
      setKind(data.capabilities.personalDocuments ? 'personal' : 'acknowledgements')
      setSection('documents')
    }
  }, [data, initialSection, query.isPlaceholderData])
  const sectionLoading = query.isPending || query.isPlaceholderData
  useLayoutEffect(() => { if (workspace.current) workspace.current.scrollTop = 0 }, [section, pointId, month])
  const selectedOrganization = { ...organization, locationId: pointId, timezone: data?.location.timezone ?? organization.timezone }
  const shift = useQuery({ queryKey: ['shift-details', organization.id, shiftId, 'profile', pointId, shiftPage], enabled: !!shiftId, queryFn: () => apiRequest<{ shift: ShiftDetails }>(`/organizations/${organization.id}/shifts/${shiftId}?locationId=${pointId}&page=${shiftPage}`) })
  useEffect(() => { if (!sectionLoading && query.isSuccess && restoreTabFocus.current && activeTab.current) { activeTab.current.focus(); restoreTabFocus.current = false } }, [query.isSuccess, sectionLoading, section, pointId, month, page])
  const selectSection = (value: ProfileSection) => { restoreTabFocus.current = true; setSection(value); setPage(1); setKind(data?.capabilities.personalDocuments ? 'personal' : 'acknowledgements') }
  const timeZone = data?.location.timezone ?? organization.timezone
  const availableSections = (Object.keys(sectionLabels) as ProfileSection[]).filter(key => key === 'overview' || data?.capabilities[key])
  const compact = !!data && !data.capabilities.time && availableSections.length === 1
  const profileOverview = section === 'overview' && !data?.capabilities.time
  const showMonth = (section === 'overview' || section === 'time') && data?.capabilities.time
  const showPoint = !!data && (data.capabilities.time || data.capabilities.schedule || data.capabilities.absences || section !== 'overview')
  const locationOptions = points.data?.locations.filter(point => !point.archivedAt) ?? []
  const openShift = (id: string) => { setShiftPage(1); setShiftId(id) }
  const openSchedule = () => { const nextMonth = data?.overview?.upcoming?.[0] ? zonedDateAndTime(data.overview.upcoming[0].scheduledStartAt, timeZone).date.slice(0, 7) : zonedDateAndTime(new Date().toISOString(), timeZone).date.slice(0, 7); onClose(); navigate(`/app/organizations/${organization.id}/schedule?${new URLSearchParams({ location: pointId, month: nextMonth, ...(data?.own ? { view: 'mine' } : {}) })}`) }
  const openRequest = (id: string, status: string) => { onClose(); navigate(`/app/organizations/${organization.id}/requests?location=${pointId}&tab=${data?.own ? 'mine' : status === 'PENDING' ? 'incoming' : 'history'}&request=${id}`) }
  return <AnimatedOverlay variant="modal" className="member-profile-overlay" dismissible={!documentId && !shiftId && !manage} onClose={onClose}>{close => <DocumentDialog title="Профиль сотрудника" eyebrow={organization.name} className={`member-profile-dialog${compact ? ' member-profile-dialog--compact' : ''}`} onClose={close} onEscape={documentId || shiftId || manage ? undefined : close}>
    {query.isPending && !data ? <div className="app-state" role="status"><span className="app-spinner" />Загружаем профиль…</div> : query.isError || !data || !member ? <div className="app-state" role="alert"><p>{query.error?.message ?? 'Профиль недоступен.'}</p><button className="app-secondary" onClick={() => section === 'overview' ? void query.refetch() : selectSection('overview')}>{section === 'overview' ? 'Повторить' : 'Вернуться к обзору'}</button></div> : <>
      <div className="member-profile-heading"><Avatar url={member.avatarUrl} name={member.displayName} className="app-avatar" /><div className="member-profile-identity"><h3>{member.displayName}{data.own && <small>это вы</small>}</h3><div className="member-profile-role">{!!member.positions?.length && <span>{member.positions.map(position => position.name).join(', ')}</span>}<RoleBadge role={member.role} name={member.roleName ?? undefined} /></div><p className={`member-profile-presence${member.online && !member.leftAt ? ' is-online' : ''}`} title="Присутствие на сайте, не отметка о выходе на смену"><i aria-hidden="true" />{member.leftAt ? 'Бывший сотрудник' : member.online ? 'Сейчас в сети' : member.lastSeenAt ? `Был в сети ${new Date(member.lastSeenAt).toLocaleString('ru-RU', { timeZone, dateStyle: 'short', timeStyle: 'short' })}` : 'Недавно не появлялся'}</p></div>{(data.capabilities.managePositions || data.capabilities.manageAccess) && <div className="member-profile-management-actions">{data.capabilities.managePositions && <button type="button" className="app-secondary" onClick={event => { managementTrigger.current = event.currentTarget; event.currentTarget.focus(); setManage('positions') }}><AccessIcon name="briefcase" />Должности</button>}{data.capabilities.manageAccess && <button type="button" className="app-secondary" onClick={event => { managementTrigger.current = event.currentTarget; event.currentTarget.focus(); setManage('access') }}><AccessIcon name="shield" />Доступ</button>}</div>}</div>
      {availableSections.length > 1 && <SegmentedNav label="Разделы профиля">{availableSections.map(key => <button type="button" className={section === key ? 'active' : ''} aria-pressed={section === key} ref={section === key ? activeTab : undefined} key={key} onClick={() => selectSection(key)}>{sectionLabels[key]}</button>)}</SegmentedNav>}
      <div className={`member-profile-workspace${profileOverview ? ' member-profile-workspace--personal' : ''}`} ref={workspace}><ProfileAbout data={data} showLocations={!profileOverview} />
      <main className="member-profile-content" aria-busy={sectionLoading}>{(showMonth || showPoint) && <div className="member-profile-filters">{showMonth && <MonthPicker label="Период профиля" value={month} currentMonth={zonedDateAndTime(new Date().toISOString(), timeZone).date.slice(0, 7)} onChange={value => { setMonth(value); setPage(1) }} />}{showPoint && <div className="member-profile-point"><ModuleIcon section="location" /><Select aria-label="Точка профиля" value={pointId} onChange={event => { setPointId(event.target.value); setPage(1) }}>{!locationOptions.some(point => point.id === pointId) && <option value={pointId}>{data.location.name}</option>}{locationOptions.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></div>}</div>}
      <AsyncPanel pending={sectionLoading} identity={`${section}:${kind}:${requestState}:${pointId}:${month}:${page}`} minHeight={compact ? 0 : 160}><div className="member-profile-panel">
      {section === 'overview' && data.overview && <>{data.capabilities.time ? <ProfileMetrics data={data} /> : <ProfileWorkplaces data={data} />}<ProfileUpcoming data={data} timezone={timeZone} onOpen={openShift} onSchedule={openSchedule} />
      {(data.overview.pendingDocuments !== null || data.overview.pendingRequests !== null) && <section className="member-profile-block member-profile-attention" aria-label="Документы и заявки">{data.overview.pendingDocuments !== null && <button type="button" className="member-profile-row" onClick={() => { selectSection('documents'); setKind('acknowledgements') }}><ModuleIcon section="documents" /><strong>Ознакомления</strong><span className={`member-profile-status ${data.overview.pendingDocuments ? 'is-pending' : 'is-success'}`}><AccessIcon name={data.overview.pendingDocuments ? 'history' : 'check'} />{data.overview.pendingDocuments ? `Ожидают: ${data.overview.pendingDocuments}` : 'Всё подтверждено'}</span><AccessIcon name="chevron" /></button>}{data.overview.pendingRequests !== null && <button type="button" className="member-profile-row" onClick={() => { selectSection('requests'); setRequestState('pending') }}><ModuleIcon section="requests" /><strong>Заявки</strong><span className={`member-profile-status ${data.overview.pendingRequests ? 'is-pending' : 'is-success'}`}><AccessIcon name={data.overview.pendingRequests ? 'history' : 'check'} />{data.overview.pendingRequests ? `На рассмотрении: ${data.overview.pendingRequests}` : 'Нет ожидающих'}</span><AccessIcon name="chevron" /></button>}</section>}{data.overview.nextAbsence && <section className="member-profile-absence"><AccessIcon name="absence" /><div><span>Следующее отсутствие</span><strong>{dateLabel(data.overview.nextAbsence.startDate)}–{dateLabel(data.overview.nextAbsence.endDate)}</strong><small>{absenceLabels[data.overview.nextAbsence.type] ?? 'Отсутствие'}</small></div></section>}</>}
      {section === 'time' && data.time && <>
        <div className="member-profile-time-summary"><div><span>Учтено за месяц</span><strong>{formatDuration(data.time.period?.workedMinutes ?? 0)}</strong></div><div><span>Завершено смен</span><strong>{data.time.period?.workedShifts ?? 0}</strong></div><p>По расписанию и правкам руководителя</p></div>
        {data.time.history.length ? <div className="member-profile-table-scroll"><table className="member-profile-table"><thead><tr><th>Дата</th><th>Смена по плану</th><th>Учтено</th><th>Источник</th><th><span className="member-profile-sr-only">Действия со сменой</span></th></tr></thead><tbody>{data.time.history.map(item => <tr key={item.id}>
          <td data-label="Дата"><strong>{dateLabel(item.scheduledStartAt, timeZone)}</strong><small>{new Date(item.scheduledStartAt).toLocaleDateString('ru-RU', { timeZone, weekday: 'long' })}</small></td>
          <td data-label="Смена по плану">{formatTime(item.scheduledStartAt, timeZone)}–{formatTime(item.scheduledEndAt, timeZone)}</td>
          <td data-label="Учтено"><strong className={item.status === 'CANCELLED' || item.attendance === 'NO_SHOW' ? 'member-profile-value--muted' : undefined}>{item.status === 'CANCELLED' ? 'Отменена' : item.attendance === 'NO_SHOW' ? 'Неявка' : accountedTimeLabel(item, timeZone)}</strong></td>
          <td data-label="Источник"><span className="member-profile-source">{item.adjusted || item.actualStartAt ? 'Правка' : 'Расписание'}</span></td>
          <td className="member-profile-table__actions"><div className="member-profile-time-actions"><TimeCorrectionAction shift={item} locationId={pointId} />{data.capabilities.schedule && <button type="button" className="member-profile-details-action" aria-label={`Открыть смену ${profileDate(item.scheduledStartAt, timeZone)}`} onClick={() => openShift(item.id)}>Подробнее<AccessIcon name="chevron" /></button>}</div></td>
        </tr>)}</tbody></table></div> : <div className="member-profile-block"><ProfileEmpty icon="schedule" title="В этом месяце смен нет" description="Выберите другой месяц или точку, чтобы посмотреть историю." /></div>}
        <Pager page={page} pages={data.time.pagination.pages} change={setPage} />
      </>}
      {section === 'documents' && data.documents && <>
        {data.capabilities.personalDocuments && data.capabilities.acknowledgements && <SegmentedNav label="Документы сотрудника"><button className={kind === 'personal' ? 'active' : ''} onClick={() => { setKind('personal'); setPage(1) }}>Личные документы</button><button className={kind === 'acknowledgements' ? 'active' : ''} onClick={() => { setKind('acknowledgements'); setPage(1) }}>Ознакомления</button></SegmentedNav>}
        <div className="member-profile-block">{data.documents.documents.length ? data.documents.documents.map(item => <button type="button" className="member-profile-row member-profile-record" key={item.id} onClick={() => setDocumentId(item.id)}><span className="member-profile-record__icon"><ModuleIcon section="documents" /></span><span className="member-profile-record__text"><strong>{item.displayName}</strong><small>{kind === 'personal' ? item.fileName : item.profileAcknowledgement?.acknowledgedAt ? `Подтверждено ${profileDate(item.profileAcknowledgement.acknowledgedAt, timeZone)}` : item.profileAcknowledgement?.deadline ? `Подтвердить до ${profileDate(item.profileAcknowledgement.deadline)}` : 'Ознакомление с документом'}</small></span>{kind !== 'personal' && <span className={`member-profile-status ${item.profileAcknowledgement?.acknowledgedAt ? 'is-success' : 'is-pending'}`}>{item.profileAcknowledgement?.acknowledgedAt ? 'Ознакомлен' : item.profileAcknowledgement?.openedAt ? 'Открыт · ожидает подтверждения' : 'Не открыт'}</span>}<AccessIcon name="chevron" /></button>) : <ProfileEmpty icon="documents" title={kind === 'personal' ? 'Личных документов пока нет' : 'Ознакомлений пока нет'} description="Здесь появятся доступные сотруднику документы." />}</div>
        <Pager page={page} pages={data.documents.pagination.pages} change={setPage} />
      </>}
      {section === 'requests' && data.requests && <>
        <SegmentedNav label="Состояние заявок"><button className={requestState === 'all' ? 'active' : ''} onClick={() => { setRequestState('all'); setPage(1) }}>Все</button><button className={requestState === 'pending' ? 'active' : ''} onClick={() => { setRequestState('pending'); setPage(1) }}>На рассмотрении</button></SegmentedNav>
        <div className="member-profile-block">{data.requests.requests.length ? data.requests.requests.map(item => <button type="button" className="member-profile-row member-profile-record" key={item.id} onClick={() => openRequest(item.id, item.status)}><span className="member-profile-record__icon"><ModuleIcon section="requests" /></span><span className="member-profile-record__text"><strong>{item.typeNameSnapshot}</strong><small>{profileDate(item.createdAt, timeZone)}</small></span><span className={`member-profile-status ${item.status === 'PENDING' ? 'is-pending' : ['APPROVED', 'REGISTERED'].includes(item.status) ? 'is-success' : ''}`}>{requestLabels[item.status] ?? item.status}</span><AccessIcon name="chevron" /></button>) : <ProfileEmpty icon="requests" title={requestState === 'pending' ? 'Нет заявок на рассмотрении' : 'Заявок пока нет'} description={requestState === 'pending' ? 'Все обращения обработаны или ещё не отправлены.' : 'Обращения сотрудника появятся в этом разделе.'} />}</div>
        <Pager page={page} pages={data.requests.pagination.pages} change={setPage} />
      </>}
      </div></AsyncPanel>
      </main></div>
    </>}
    {manage && member && createPortal(<div className="member-profile-management">{manage === 'positions' ? <MemberPositions organization={selectedOrganization} member={{ ...member, locations: member.locations.map(point => ({ locationId: point.id, role: 'MEMBER' as const })) }} onClose={() => setManage(null)} onSaved={() => { setManage(null); void query.refetch() }} /> : <MemberAccessDialog org={organization.id} memberId={member.id} onClose={() => { setManage(null); void query.refetch() }} />}</div>, document.body)}
    {documentId && createPortal(<AnimatedOverlay variant="modal" className="member-profile-child-overlay" onClose={() => setDocumentId(null)}>{childClose => <DocumentDrawer organizationId={organization.id} documentId={documentId} pointId={pointId} manager={false} onClose={childClose} />}</AnimatedOverlay>, document.body)}
    {shiftId && createPortal(<AnimatedOverlay variant="modal" className="member-profile-child-overlay" onClose={() => setShiftId(null)}>{childClose => <ShiftDetailsDialog shift={shift.data?.shift} pending={shift.isPending} error={shift.error?.message} onRetry={() => void shift.refetch()} timezone={timeZone} locationId={pointId} page={shiftPage} onPage={setShiftPage} onClose={childClose} />}</AnimatedOverlay>, document.body)}
  </DocumentDialog>}</AnimatedOverlay>
}
