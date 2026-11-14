import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import EmploymentPeriods from '../../component/ui/employment-periods/employment-periods.tsx'
import ChangeTimeline from '../../component/ui/change-timeline/change-timeline.tsx'
import type { AdminPersonnel, PageResult } from './contracts.ts'
import { personnelLabels, type PersonnelData } from '../../shared/member-personnel.ts'
import { useAdminData } from './admin-data.tsx'
import { Loading, ReadError } from './admin-feedback.tsx'
import { Panel, AdminBadge, Empty } from './admin-elements.tsx'
import { AdminLink as Link } from './admin-link.tsx'
import OperationsToolbar from './admin-filters.tsx'

export function AdminPersonnelCard({ member }: { member: AdminPersonnel }) {
  const [history, setHistory] = useState(false)

  return (
    <article className="admin-personnel-card">
      <header>
        <Link to={'/admin/users/' + member.userId}>{member.accountName}</Link>
        <AdminBadge>{member.leftAt ? 'В архиве' : 'Работает'}</AdminBadge>
      </header>
      <p className="admin-note">Кадровая карточка: {member.organizationName}. Данные личного аккаунта хранятся отдельно.</p>
      <dl className="admin-key-values">
        {(Object.keys(personnelLabels) as Array<keyof typeof personnelLabels>).map(key => (
          <div key={key}><dt>{personnelLabels[key]}</dt><dd>{member.record[key] || 'Не указано'}</dd></div>
        ))}
        <div><dt>Должности</dt><dd>{member.positions.join(', ') || 'Не назначены'}</dd></div>
        <div><dt>Команды</dt><dd>{member.teams.join(', ') || 'Не назначены'}</dd></div>
        <div><dt>Точки</dt><dd>{member.locations.join(', ') || 'Не назначены'}</dd></div>
      </dl>
      <EmploymentPeriods periods={member.periods} />
      <button className="admin-btn" aria-expanded={history} onClick={() => setHistory(!history)}>
        История кадровых изменений
      </button>
      {history && <AdminPersonnelHistory member={member} />}
    </article>
  )
}

function AdminPersonnelHistory({ member }: { member: AdminPersonnel }) {
  const [page, setPage] = useState(1)
  const { data, error, refresh, readState } = useAdminData<NonNullable<PersonnelData['history']>>(
    `/monitoring/organizations/${member.organizationId}/personnel/${member.id}/history?page=${page}`,
  )
  if (!data) return <Loading error={error} retry={refresh} />

  return (
    <div className="admin-personnel-history">
      <ReadError error={error} retry={refresh} state={readState} />
      {data.items.length
        ? <ChangeTimeline items={data.items} labels={personnelLabels} timezone="Europe/Moscow" />
        : <Empty>Изменений пока нет.</Empty>}
      {data.pages > 1 && (
        <div className="admin-pagination">
          <button className="admin-btn" disabled={page === 1} onClick={() => setPage(page - 1)}>Назад</button>
          <span>{page} / {data.pages}</span>
          <button className="admin-btn" disabled={page === data.pages} onClick={() => setPage(page + 1)}>Далее</button>
        </div>
      )}
    </div>
  )
}

export function OrganizationPersonnel({ id }: { id: string }) {
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('personnelPage') ?? 1)
  const search = params.get('personnelSearch') ?? ''
  const { data, error, refresh, readState } = useAdminData<PageResult<AdminPersonnel>>(
    `/monitoring/organizations/${id}/personnel?page=${page}&search=${encodeURIComponent(search)}`,
  )

  function changePage(nextPage: number) {
    const next = new URLSearchParams(params)
    next.set('personnelPage', String(nextPage))
    setParams(next)
  }

  return (
    <Panel title="Кадровые карточки" subtitle="Сведения организации доступны для просмотра. Изменения выполняет организация.">
      <OperationsToolbar hidePeriod searchKey="personnelSearch" pageKey="personnelPage"
        label="Поиск кадровых карточек" placeholder="ФИО, табельный номер, рабочая почта" />
      {!data ? <Loading error={error} retry={refresh} /> : (
        <>
          <ReadError error={error} retry={refresh} state={readState} />
          {data.items.map(member => <AdminPersonnelCard member={member} key={member.id} />)}
          {!data.items.length && <Empty>Сотрудники не найдены.</Empty>}
          <div className="admin-pagination">
            <span>Найдено: {data.total}</span>
            <button className="admin-btn" disabled={page === 1} onClick={() => changePage(page - 1)}>Назад</button>
            <span>{page} / {Math.max(1, Math.ceil(data.total / 20))}</span>
            <button className="admin-btn" disabled={page * 20 >= data.total} onClick={() => changePage(page + 1)}>Далее</button>
          </div>
        </>
      )}
    </Panel>
  )
}
