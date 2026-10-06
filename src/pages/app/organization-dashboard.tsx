import { Link } from 'react-router-dom'
import Avatar from '../../component/ui/avatar/avatar.tsx'
import { useQuery } from '@tanstack/react-query'
import type { OrganizationLocation } from '../../app/organizations/types.ts'
import DocumentDialog from './documents/document-dialog.tsx'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import { formatTime } from '../../app/schedule/date-utils.ts'
import DashboardOverview from './dashboard-overview.tsx'
import { locationTone } from '../../app/organizations/format.ts'
import { useState } from 'react'
import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { formatRussianPhone } from '../../app/profile/phone.ts'
import { useAuth } from '../../app/auth/auth-context.tsx'



export default function OrganizationDashboard({ organization }: { organization: OrganizationSummary }) {
  const { apiRequest } = useAuth()
  type Point = OrganizationLocation & { today: string; todayMemberCount: number; shifts: Array<{ id: string; memberId: string; name: string; avatarUrl: string | null; startAt: string; endAt: string; position: string | null }> }
  const overview = useQuery({ queryKey: ['locations-overview', organization.id], queryFn: () => apiRequest<{ locations: Point[] }>(`/organizations/${organization.id}/locations/overview`), refetchInterval: 30000 })
  const [todayPointId, setTodayPointId] = useState<string | null>(null)
  const todayPoint = overview.data?.locations.find(point => point.id === todayPointId)
  return <div className="workspace-dashboard dashboard-home"><DashboardOverview organization={organization} />
    <section className="location-overview"><h2>Сегодня по точкам</h2>{overview.isLoading ? <p>Загружаем смены…</p> : overview.isError ? <p role="alert">Не удалось загрузить смены. <button className="app-secondary" onClick={() => void overview.refetch()}>Повторить</button></p> : <div className="location-overview__grid">{overview.data?.locations.map(point => {
      return <button type="button" className="location-today-card" data-tone={locationTone(point.id)} key={point.id} onClick={() => setTodayPointId(point.id)} aria-label={`${point.name}: сегодня на смене ${point.todayMemberCount}. Посмотреть сотрудников`}>
        <span className="location-today-card__heading"><PointMark /><span className="location-today-card__title"><strong>{point.name}</strong><span className="location-today-card__address">{[point.city, point.address].filter(Boolean).join(', ') || 'Адрес не указан'}</span></span><svg className="location-today-card__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></span>
        {point.shifts.length ? <><span className="location-today-card__metric"><strong>{point.todayMemberCount}</strong><span>{staffCount(point.todayMemberCount)} на смене<small>{point.memberCount} в составе точки</small></span></span><span className="location-today-card__people">{point.shifts.slice(0, 2).map(shift => <TodayShift key={shift.id} shift={shift} timezone={point.timezone} />)}{point.shifts.length > 2 && <span className="location-today-card__more">Ещё {point.shifts.length - 2} смен · Смотреть всех →</span>}</span></> : <TodayEmpty />}
      </button>
    })}</div>}</section>
    {todayPoint && <AnimatedOverlay variant="modal" onClose={() => setTodayPointId(null)}>{close => <DocumentDialog className="location-today-dialog" title="Сегодня на смене" onClose={close} headerContent={<header data-tone={locationTone(todayPoint.id)}><PointMark /><div><p className="app-eyebrow">{todayPoint.name}</p><h2>Сегодня на смене</h2><p className="location-today-dialog__count">{todayPoint.todayMemberCount} {staffCount(todayPoint.todayMemberCount)} · {todayPoint.memberCount} в составе точки</p></div><button type="button" aria-label="Закрыть" onClick={close}>×</button></header>}><div className="location-today-dialog__list">{todayPoint.shifts.length ? todayPoint.shifts.map(shift => <TodayShift key={shift.id} shift={shift} timezone={todayPoint.timezone} />) : <TodayEmpty />}</div><footer><button className="app-secondary" onClick={close}>Закрыть</button><Link className="app-primary" to={`/app/organizations/${organization.id}/schedule?location=${todayPoint.id}&month=${todayPoint.today.slice(0, 7)}&day=${todayPoint.today}`}>Открыть день в расписании</Link></footer></DocumentDialog>}</AnimatedOverlay>}
    {(organization.contactEmail || organization.phone || organization.website || organization.address) && <section className="organization-public-card"><div><p className="app-eyebrow">Контакты</p><h2>Профиль организации</h2></div><dl>{organization.contactEmail && <div><dt>Почта</dt><dd><a href={`mailto:${organization.contactEmail}`}>{organization.contactEmail}</a></dd></div>}{organization.phone && <div><dt>Телефон</dt><dd><a href={`tel:${organization.phone}`}>{formatRussianPhone(organization.phone)}</a></dd></div>}{organization.website && <div><dt>Сайт</dt><dd><a href={organization.website} target="_blank" rel="noreferrer">{organization.website.replace(/^https?:\/\//, '')}</a></dd></div>}{organization.address && <div><dt>Адрес</dt><dd>{organization.address}</dd></div>}</dl></section>}

  </div>
}

function staffCount(count: number) {
  const last = count % 10, hundred = count % 100
  return hundred >= 11 && hundred <= 14 ? 'сотрудников' : last === 1 ? 'сотрудник' : last >= 2 && last <= 4 ? 'сотрудника' : 'сотрудников'
}
function PointMark() { return <span className="location-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></svg></span> }
function TodayEmpty() { return <span className="location-today-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 10h18" /></svg><span>Сегодня сотрудников нет<small>Смены не назначены</small></span></span> }
function TodayShift({ shift, timezone }: { shift: { name: string; avatarUrl: string | null; startAt: string; endAt: string; position: string | null }; timezone: string }) {
  return <span className="location-today-person"><Avatar url={shift.avatarUrl} name={shift.name} className="app-avatar" /><span className="location-today-person__name"><strong>{shift.name}</strong><small>{shift.position || 'Должность не указана'}</small></span><span className="location-today-person__time"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></svg>{formatTime(shift.startAt, timezone)} — {formatTime(shift.endAt, timezone)}</span></span>
}
