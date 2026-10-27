import type { MemberProfileData } from '../../../../app/member-profile/types.ts'
import { formatDuration, formatTime, formatMonth, zonedDateAndTime } from '../../../../app/schedule/date-utils.ts'
import { profileDate } from '../../../../app/member-profile/presentation.ts'
import { formatRussianPhone } from '../../../../app/profile/phone.ts'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import ModuleIcon from '../../../../component/ui/module-icon.tsx'
import { AccessIcon } from '../../settings/access/access-elements.tsx'

export function ProfileEmpty({ icon, title, description }: { icon: string; title: string; description?: string }) {
  return <div className="member-profile-empty"><ModuleIcon section={icon} /><p><strong>{title}</strong>{description && <span>{description}</span>}</p></div>
}
export function ProfileAbout({ data, showLocations }: { data: MemberProfileData; showLocations: boolean }) {
  const member = data.member, toast = useToast()
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast('Скопировано в буфер обмена.', 'success') }
    catch { toast('Не удалось скопировать. Выделите и скопируйте значение вручную.', 'error') }
  }
  return <aside className="member-profile-about">
    <h3>{data.own ? 'Обо мне' : 'О сотруднике'}</h3>
    {member.bio && <div className="member-profile-bio"><span>О себе</span><p>{member.bio}</p></div>}
    <dl>
      <div className="member-profile-fact"><dt><ModuleIcon section="employees" />В команде с</dt><dd>{profileDate(member.joinedAt, data.location.timezone)}</dd></div>
      {member.leftAt && <div className="member-profile-fact"><dt><AccessIcon name="history" />Дата выхода</dt><dd>{profileDate(member.leftAt, data.location.timezone)}</dd></div>}
      {showLocations && <div className="member-profile-fact"><dt><ModuleIcon section="location" />Работает в точках</dt><dd><div className="member-profile-chips">{member.role === 'OWNER' ? <span>Все точки</span> : member.locations.length ? member.locations.map(point => <span key={point.id}>{point.name}</span>) : <span>Пока не назначены</span>}</div></dd></div>}
    </dl>
    {(member.email || member.phone) && <section className="member-profile-contacts" aria-label="Контакты сотрудника"><h4>Контакты</h4>
      {member.email && <div><span>Почта</span><a href={`mailto:${member.email}`}>{member.email}</a><button type="button" aria-label="Скопировать почту" onClick={() => void copy(member.email)}><AccessIcon name="copy" /></button></div>}
      {member.phone && <div><span>Телефон</span><a href={`tel:${member.phone}`}>{formatRussianPhone(member.phone)}</a><button type="button" aria-label="Скопировать телефон" onClick={() => void copy(member.phone!)}><AccessIcon name="copy" /></button></div>}
    </section>}
  </aside>
}
export function ProfileWorkplaces({ data }: { data: MemberProfileData }) {
  const member = data.member
  return <>
    <section className="member-profile-block member-profile-workplaces"><header><ModuleIcon section="location" /><h3>Где работает</h3></header>
      {member.role === 'OWNER' ? <div className="member-profile-workplace"><span className="member-profile-workplace__icon"><ModuleIcon section="location" /></span><div><strong>Все точки организации</strong><span>Владелец организации</span></div></div> : member.locations.length ? member.locations.map(point => <div key={point.id} className={`member-profile-workplace${point.id === data.location.id ? ' is-current' : ''}`}><span className="member-profile-workplace__icon"><ModuleIcon section="location" /></span><div><strong>{point.name}</strong>{point.id === data.location.id && <span>Выбранная точка</span>}</div></div>) : <div className="member-profile-empty"><ModuleIcon section="location" /><p>Точки пока не назначены</p></div>}
    </section>
    {!!member.positions?.length && <section className="member-profile-block member-profile-functions"><header><AccessIcon name="briefcase" /><h3>Должности</h3></header><div className="member-profile-chips">{member.positions.map(position => <span key={position.id}>{position.name}</span>)}</div></section>}
  </>
}
export function ProfileMetrics({ data }: { data: MemberProfileData }) {
  const overview = data.overview, period = overview?.period
  return <section className="member-profile-statistics" aria-label={`Рабочие показатели: ${formatMonth(data.month)}`}>
    <p className="member-profile-period-label">{formatMonth(data.month)}</p>
    <div className="member-profile-metrics">
      <article className="member-profile-metric--primary"><span><AccessIcon name="history" />Учтено часов</span><strong>{formatDuration(period?.workedMinutes ?? 0)}</strong><small>По расписанию и правкам</small></article>
      <article><span><ModuleIcon section="events" />Завершено смен</span><strong>{period?.workedShifts ?? 0}</strong><small>За выбранный месяц</small></article>
      <article><span><ModuleIcon section="schedule" />Запланировано</span><strong>{formatDuration(period?.plannedMinutes ?? 0)}</strong><small>{period?.plannedShifts ? `Впереди смен: ${period.plannedShifts}` : 'Будущих смен в месяце нет'}</small></article>
    </div>
    <p className={`member-profile-corrections${overview?.corrections ? ' has-corrections' : ''}`}><AccessIcon name={overview?.corrections ? 'history' : 'check'} />{overview?.corrections ? `Смен с корректировками: ${overview.corrections}` : 'Без корректировок за месяц'}</p>
  </section>
}
export function ProfileUpcoming({ data, timezone, onOpen, onSchedule }: { data: MemberProfileData; timezone: string; onOpen: (id: string) => void; onSchedule: () => void }) {
  const upcoming = data.overview?.upcoming
  if (!upcoming) return null
  const today = zonedDateAndTime(new Date().toISOString(), timezone).date
  return <section className="member-profile-block member-profile-upcoming"><header><ModuleIcon section="schedule" /><h3>Ближайшие смены</h3><button type="button" className="member-profile-schedule-link" onClick={onSchedule}>В расписание<AccessIcon name="chevron" /></button></header>
    {upcoming.length ? upcoming.map(item => {
      const start = zonedDateAndTime(item.scheduledStartAt, timezone).date, end = zonedDateAndTime(item.scheduledEndAt, timezone).date
      const date = new Date(item.scheduledStartAt), day = date.toLocaleDateString('ru-RU', { timeZone: timezone, day: 'numeric' }), month = date.toLocaleDateString('ru-RU', { timeZone: timezone, month: 'short' }).replace('.', '')
      const difference = (Date.parse(start) - Date.parse(today)) / 86400000
      const weekday = date.toLocaleDateString('ru-RU', { timeZone: timezone, weekday: 'long' })
      const label = `${difference === 0 ? 'Сегодня · ' : difference === 1 ? 'Завтра · ' : ''}${weekday}`
      return <button type="button" key={item.id} className="member-profile-shift" aria-label={`Смена ${profileDate(item.scheduledStartAt, timezone)}, ${formatTime(item.scheduledStartAt, timezone)}–${formatTime(item.scheduledEndAt, timezone)}`} onClick={() => onOpen(item.id)}>
        <time className="member-profile-date-tile" dateTime={start}><strong>{day}</strong><span>{month}</span></time>
        <span className="member-profile-shift__details"><strong>{label}</strong><span>{formatTime(item.scheduledStartAt, timezone)}–{start !== end ? `${new Date(item.scheduledEndAt).toLocaleDateString('ru-RU', { timeZone: timezone, day: 'numeric', month: 'short' })}, ` : ''}{formatTime(item.scheduledEndAt, timezone)}</span><small><ModuleIcon section="location" />{data.location.name}</small></span>
        {item.positionNameSnapshot && <span className="member-profile-shift__position">{item.positionNameSnapshot}</span>}<AccessIcon name="chevron" />
      </button>
    }) : <div className="member-profile-empty"><ModuleIcon section="schedule" /><p><strong>Ближайших смен пока нет</strong><span>Новые смены в точке «{data.location.name}» появятся здесь после назначения.</span></p></div>}
  </section>
}
