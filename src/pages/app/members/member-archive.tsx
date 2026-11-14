import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import EmploymentPeriods from '../../../component/ui/employment-periods/employment-periods.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import ModuleIcon from '../../../component/ui/module-icon.tsx'
import { AccessIcon } from '../settings/access/access-elements.tsx'
import DatePicker from '../../../component/ui/date-picker/date-picker.tsx'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useLocations } from '../../../app/organizations/queries.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { useMemberProfile } from '../../../app/member-profile/context.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import PageHeading from '../../../component/ui/page-heading/page-heading.tsx'
import Select from '../../../component/ui/select/select.tsx'
import MemberInvitations from './member-invitations.tsx'
import type { listFormerMembers } from '../../../server/organizations/member-archive.ts'

type Archive = Awaited<ReturnType<typeof listFormerMembers>>
type MemberArchiveProps = { organization: OrganizationSummary; navigation: ReactNode }
const date = (value: Date | string | null) => value ? new Date(value).toLocaleDateString('ru-RU') : 'Неизвестно'

export default function MemberArchive({ organization, navigation }: MemberArchiveProps) {
  const { apiRequest, locationId } = useAuth()
  const profile = useMemberProfile()
  const points = useLocations(organization.id)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [point, setPoint] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  const query = new URLSearchParams({ state: 'former', page: String(page), pageSize: '20' })
  if (term) query.set('search', term)
  if (point) query.set('pointId', point)
  if (from) query.set('departedFrom', from)
  if (to) query.set('departedTo', to)
  const archive = useQuery({
    queryKey: ['organization-members', organization.id, 'archive', query.toString(), locationId],
    queryFn: () => apiRequest<Archive>(`/organizations/${organization.id}/members?${query}`),
  })

  return (
    <section className="members-page member-archive-page">
      <PageHeading title="Сотрудники" description="Управление командой, ролями и доступами."
        actions={canAccess(organization, 'members.invite') && (
          <button className="app-primary" onClick={() => setInviting(true)}>Повторно пригласить</button>
        )} />
      {navigation}
      <div className="member-archive-intro">
        <span className="member-archive-intro__icon"><ModuleIcon section="employees" /></span>
        <div>
          <h2>Архив сотрудников</h2>
          <p>Рабочая история сохраняется. Повторный приём — через приглашение, без возврата прежних прав.</p>
        </div>
      </div>
      <div className="members-toolbar">
        <label>
          <span>Поиск бывшего сотрудника</span>
          <input type="search" value={search} placeholder="Имя или доступная рабочая почта"
            onChange={event => { setSearch(event.target.value); setPage(1) }} />
        </label>
        <label>
          <span>Последняя точка</span>
          <Select value={point} onChange={event => { setPoint(event.target.value); setPage(1) }}>
            <option value="">Все доступные точки</option>
            {points.data?.locations.filter(item => organization.owner || item.permissions?.includes('members.remove'))
              .map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </label>
        <label>
          <span>Исключён с</span>
          <DatePicker aria-label={from ? 'Исключён с' : 'Исключён с: выберите дату'} value={from}
            max={to || undefined} onChange={event => { setFrom(event.target.value); setPage(1) }} />
        </label>
        <label>
          <span>Исключён по</span>
          <DatePicker aria-label={to ? 'Исключён по' : 'Исключён по: выберите дату'} value={to}
            min={from || undefined} onChange={event => { setTo(event.target.value); setPage(1) }} />
        </label>
      </div>
      {archive.isPending ? (
        <div className="app-state" role="status">Загружаем архив…</div>
      ) : archive.isError ? (
        <div className="app-state" role="alert">
          <p>{archive.error.message}</p>
          <button className="app-secondary" onClick={() => void archive.refetch()}>Повторить</button>
        </div>
      ) : (
        <>
          <p className="members-count">Найдено: {archive.data.pagination.total}</p>
          {!archive.data.members.length ? (
            <div className="app-state">Бывшие сотрудники по этим условиям не найдены.</div>
          ) : (
            <div className="member-archive-list">
              {archive.data.members.map(member => (
                <article className="member-archive-card" key={member.id}>
                  <header>
                    <Avatar url={null} name={member.displayName} className="app-avatar" />
                    <div>
                      <strong>{member.displayName}</strong>
                      {member.email && <a href={'mailto:' + member.email}>{member.email}</a>}
                      <span className="member-archive-status">В архиве</span>
                    </div>
                  </header>
                  <dl className="member-archive-facts">
                    <div><dt>Первое вступление</dt><dd>{date(member.joinedAt)}</dd></div>
                    <div><dt>Исключён</dt><dd>{date(member.leftAt)}</dd></div>
                    <div><dt>Точки</dt><dd>{member.locations.map(item => item.name).join(' · ') || 'Не назначены'}</dd></div>
                  </dl>
                  <button className="app-secondary member-archive-open" onClick={() => profile?.open(member.id, {
                    locationId: point || member.locations[0]?.id || organization.locationId,
                  })}>
                    Рабочая история<AccessIcon name="chevron" />
                  </button>
                  <EmploymentPeriods periods={member.periods} timezone={organization.timezone} />
                </article>
              ))}
            </div>
          )}
          <nav className="members-pagination" aria-label="Страницы архива">
            <button className="app-secondary" disabled={page <= 1 || archive.isFetching}
              onClick={() => setPage(value => value - 1)}>Назад</button>
            <span>Страница {page} из {archive.data.pagination.pages}</span>
            <button className="app-secondary" disabled={page >= archive.data.pagination.pages || archive.isFetching}
              onClick={() => setPage(value => value + 1)}>Далее</button>
          </nav>
        </>
      )}
      {inviting && <MemberInvitations organization={organization} onClose={() => setInviting(false)} />}
    </section>
  )
}
