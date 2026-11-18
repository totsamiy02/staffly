import { useModuleFilters } from '../../../app/workspace/module-filters.ts'
import AsyncPanel from '../../../component/ui/async-panel.tsx'
import { useAccessRoles } from '../../../app/access/queries.ts'
import VacationPlanning from './vacations/vacation-planning.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import RequestsWorkspace from './requests-workspace.tsx'
import { requestSections } from '../../../app/requests/navigation.ts'
import RequestOffers from './request-offers.tsx'
import { useLocations, useOrganizationDirectory } from '../../../app/organizations/queries.ts'
import EmployeePicker from '../shared/employee-picker.tsx'
import DatePicker from '../../../component/ui/date-picker/date-picker.tsx'
import Select from '../../../component/ui/select/select.tsx'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { OrganizationRole, OrganizationSummary } from '../../../app/organizations/types.ts'
import { useRequests, useRequestTypes } from '../../../app/requests/queries.ts'
import type { RequestStatus, StaffRequest } from '../../../app/requests/types.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import './requests.scss'
import './requests-redesign.scss'
import { statusLabels } from './request-format.ts'
import RequestCard from './request-card.tsx'
import { RequestForm } from './request-form.tsx'
import { RequestDrawer } from './request-drawer.tsx'

export default function RequestsPage({ organization }: { organization: OrganizationSummary }) {
  const [params] = useSearchParams()
  const sections = requestSections(organization)
  const selected = sections.find(section => section.id === params.get('tab'))?.id ?? sections[0]?.id ?? 'mine'
  if (selected === 'vacations') return <RequestsWorkspace organization={organization} section="vacations">
    <VacationPlanning organization={organization} />
  </RequestsWorkspace>
  if (selected === 'offers') return <RequestsWorkspace organization={organization} section="offers">
    <RequestOffers organization={organization} />
  </RequestsWorkspace>
  return <RequestListPage organization={organization} />
}

function RequestListPage({ organization }: { organization: OrganizationSummary }) {
  const reviewer = canAccess(organization, 'requests.view')
  const ownRequests = canAccess(organization, 'requests.own'), staffingAccess = canAccess(organization, 'staffing.respond') || canAccess(organization, 'staffing.create')
  const defaultScope = ownRequests ? 'mine' : reviewer ? 'incoming' : 'staffing'
  const types = useRequestTypes(organization.id)
  const [params, setParams] = useSearchParams()
  const initialScope = params.get('tab')
  const [scope, setScope] = useState<'mine' | 'incoming' | 'history' | 'staffing'>(initialScope === 'staffing' && staffingAccess ? 'staffing' : reviewer && (initialScope === 'incoming' || initialScope === 'history') ? initialScope : initialScope === 'mine' && ownRequests ? 'mine' : defaultScope)
  const points = useLocations(organization.id)
  const filters = useModuleFilters('requests', organization.id, {
    pointId: organization.locationId ?? 'all',
    memberId: '',
    from: '',
    to: '',
    page: 1,
    typeId: '',
    role: '',
    search: '',
    status: '' as RequestStatus | ''
  })
  const [pointId, setPointId] = filters.field('pointId')
  const members = useOrganizationDirectory(organization.id, reviewer)
  const filterMembers = members.data?.members.filter(member => member.locations.some(point => pointId === 'all' || !pointId || point.locationId === pointId)) ?? []
  const [memberId, setMemberId] = filters.field('memberId')
  const [from, setFrom] = filters.field('from'), [to, setTo] = filters.field('to')
  const [page, setPage] = filters.field('page')
  const [extraFilters, setExtraFilters] = useState(false)
  const [typeId, setTypeId] = filters.field('typeId')
  const [role, setRole] = filters.field('role')
  const accessRoles = useAccessRoles(organization.id)
  const [search, setSearch] = filters.field('search')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = filters.field('status')
  const [creating, setCreating] = useState(Boolean(params.get('changeShift') || params.get('proposeShift') || params.get('dayOffShift') || params.get('reportAbsence') || params.get('staffing')))
  const [editingRequest, setEditingRequest] = useState<StaffRequest | null>(null)
  const selectedId = params.get('request')
  useLayoutEffect(() => {
    if (initialScope === 'absences') setParams(current => {
      const next = new URLSearchParams(current)
      next.set('tab', 'mine')
      return next
    }, { replace: true })
  }, [initialScope, setParams])
  useLayoutEffect(() => {
    if (initialScope === 'staffing' && staffingAccess) setScope('staffing'); else if (reviewer && (initialScope === 'incoming' || initialScope === 'history')) setScope(initialScope); else setScope(initialScope === 'mine' && ownRequests ? 'mine' : defaultScope)
  }, [initialScope, reviewer, staffingAccess, ownRequests, defaultScope])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])
  const list = useRequests(organization.id, scope, {
    page,
    pointId: pointId || undefined,
    memberId: memberId || undefined,
    from: from || undefined,
    to: to || undefined,
    status: scope === 'incoming' ? undefined : status || undefined,
    typeId: typeId || undefined,
    role: scope === 'mine' || !['OWNER', 'ADMIN', 'MEMBER'].includes(role) ? undefined : role as OrganizationRole,
    roleId: scope === 'mine' || ['OWNER', 'ADMIN', 'MEMBER'].includes(role) ? undefined : role || undefined,
    search: scope === 'mine' ? undefined : debouncedSearch || undefined
  })
  function openRequest(id: string) {
    const request = list.data?.requests.find(item => item.id === id)
    setParams((current) => {
      const result = new URLSearchParams(current)
      result.set('tab', scope)
      result.set('request', id)
      if (request?.locationId) result.set('location', request.locationId)
      return result
    })
  }
  function closeRequest() {
    setParams((current) => {
      const result = new URLSearchParams(current)
      result.delete('request')
      return result
    }, { replace: true })
  }

  return <RequestsWorkspace
    organization={organization}
    section={scope}
    actions={(scope === 'mine' && canAccess(organization, 'requests.create') && (organization.assignedToLocation !== false || organization.owner) || scope === 'staffing' && canAccess(organization, 'staffing.create')) && <button className="app-primary" onClick={() => {
      if (scope === 'staffing') setParams(current => {
        const next = new URLSearchParams(current)
        next.set('staffing', '1')
        return next
      })
      setCreating(true)
    }}><span aria-hidden="true">＋</span> Создать заявку</button>}>
    <div className="request-list-toolbar">
      <span>
        {list.data ? `${list.data.pagination.total} заявок` : 'Заявки'}
      </span>
      <button
        className="app-secondary"
        aria-expanded={extraFilters}
        onClick={() => setExtraFilters(true)}><svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>Фильтры{[from, to, memberId, role, typeId, status, search].filter(Boolean).length > 0 && <small>
          {[from, to, memberId, role, typeId, status, search].filter(Boolean).length}
        </small>}</button>
    </div>
    {extraFilters && <AnimatedOverlay variant="modal" onClose={() => setExtraFilters(false)}>
      {close => <DocumentDialog
        title="Фильтры"
        className="request-filters-dialog"
        eyebrow="Заявки"
        onClose={close}>
        <div className="request-filter-dialog-fields">
          <label>
            <span>Точка</span>
            <Select value={pointId} onChange={event => {
              setPointId(event.target.value)
              setMemberId('')
              setPage(1)
            }}>
              <option value="all">
                {scope === 'mine' || scope === 'staffing' ? 'Все точки' : 'Все управляемые точки'}
              </option>
              {points.data?.locations.filter(point => !point.archivedAt && (scope === 'mine' || scope === 'staffing' || point.permissions?.includes('requests.view'))).map(point => <option key={point.id} value={point.id}>
                {point.name}
              </option>)}
            </Select>
          </label>
          <label>
            <span>Тип заявки</span>
            <Select value={typeId} onChange={(event) => {
              setTypeId(event.target.value)
              setPage(1)
            }}>
              <option value="">Все типы</option>
              {types.data?.types.map((type) => <option value={type.id} key={type.id}>
                {type.name}
              </option>)}
            </Select>
          </label>
          {scope !== 'incoming' && <label>
            <span>Статус</span>
            <Select value={status} onChange={(event) => {
              setStatus(event.target.value as RequestStatus | '')
              setPage(1)
            }}>
              <option value="">Все статусы</option>
              {Object.entries(statusLabels).filter(([value]) => scope === 'mine' || scope === 'staffing' || value !== 'PENDING').map(([value, label]) => <option value={value} key={value}>
                {label}
              </option>)}
            </Select>
          </label>}
          {reviewer && !['mine', 'staffing'].includes(scope) && <>
            <label className="requests-search">
              <span>Поиск заявки</span>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
                placeholder="Имя, фамилия или почта"
                autoComplete="off" />
            </label>
          </>}
          {reviewer && !['mine', 'staffing'].includes(scope) && <>
            <label className="request-extra-filter">
              <span>Роль автора</span>
              <Select value={role} onChange={(event) => {
                setRole(event.target.value)
                setPage(1)
              }}>
                <option value="">Все роли</option>
                <option value="OWNER">Владелец</option>
                {accessRoles.data?.roles.filter(r => r.systemCode !== 'OWNER').map(r => <option key={r.id} value={r.id}>
                  {r.name}
                </option>)}
              </Select>
            </label>
            <div className="request-extra-filter">
              <EmployeePicker
                members={filterMembers}
                value={memberId}
                onChange={value => {
                  setMemberId(value)
                  setPage(1)
                }}
                required={false}
                emptyLabel="Все сотрудники" />
            </div>
          </>}
          <label className="request-extra-filter">
            <span>Период с</span>
            <DatePicker value={from} onChange={event => {
              setFrom(event.target.value)
              setPage(1)
            }} />
          </label>
          <label className="request-extra-filter">
            <span>По</span>
            <DatePicker
              min={from}
              value={to}
              onChange={event => {
                setTo(event.target.value)
                setPage(1)
              }} />
          </label>
        </div>
        <footer>
          <button className="app-secondary" onClick={() => {
            setFrom('')
            setTo('')
            setMemberId('')
            setRole('')
            setTypeId('')
            setStatus('')
            setSearch('')
            setPage(1)
          }}>Сбросить</button>
          <button className="app-primary" onClick={close}>Готово</button>
        </footer>
      </DocumentDialog>}
    </AnimatedOverlay>}
    <AsyncPanel
      pending={list.isLoading}
      identity={`${scope}:${page}:${pointId}:${memberId}:${from}:${to}:${status}:${typeId}:${role}:${debouncedSearch}`}
      minHeight={320}>
      {list.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем заявки…</div> : list.isError ? <div className="app-state">
        <p>Не удалось загрузить заявки.</p>
        <button className="app-secondary" onClick={() => void list.refetch()}>Повторить</button>
      </div> : !list.data?.requests.length ? <div className="requests-empty">
        <h2>
          {scope === 'staffing' ? 'Открытых подмен пока нет' : scope === 'mine' ? 'У вас пока нет заявок' : scope === 'incoming' ? 'Нет заявок для рассмотрения' : 'В архиве пока пусто'}
        </h2>
        <p>
          {scope === 'staffing' ? 'Здесь появятся заявки точек, которым нужны сотрудники на смену.' : scope === 'mine' ? 'Создайте заявку, когда потребуется отпуск, отгул или изменение смены.' : scope === 'incoming' ? 'Новые заявки участников организации появятся здесь, в том числе ваши.' : 'Здесь появятся решённые и отменённые заявки организации.'}
        </p>
      </div> : <div className="requests-list">
        <div className="request-table-header" aria-hidden="true">
          <span>Сотрудник</span>
          <span>Тип / точка</span>
          <span>Период</span>
          <span>Дней</span>
          <span>Статус</span>
          <span>Дата подачи</span>
          <span />
        </div>
        {list.data.requests.map((request) => <RequestCard
          key={request.id}
          request={request}
          incoming={scope !== 'mine'}
          timezone={organization.timezone}
          onOpen={() => openRequest(request.id)} />)}
      </div>}
      {list.data && <nav className="members-pagination">
        <button
          className="app-secondary"
          disabled={page === 1}
          onClick={() => setPage((value) => value - 1)}>Назад</button>
        <span>Показано {list.data.requests.length} из {list.data.pagination.total} · Страница {page} из {Math.max(1, list.data.pagination.pages)}</span>
        <button
          className="app-secondary"
          disabled={page >= list.data.pagination.pages}
          onClick={() => setPage((value) => value + 1)}>Далее</button>
      </nav>}
    </AsyncPanel>
    {creating && <AnimatedOverlay variant="modal" onClose={() => setCreating(false)}>
      {(close) => <RequestForm
        organization={organization}
        initialSystemCode={params.has('staffing') || scope === 'staffing' ? 'STAFFING' : params.has('dayOffShift') ? 'DAY_OFF' : params.has('reportAbsence') ? 'SICK' : undefined}
        initialShiftId={params.get('changeShift') ?? params.get('dayOffShift') ?? undefined}
        initialProposal={params.has('proposeShift')}
        initialProposalDate={params.get('proposalDate') ?? undefined}
        onClose={() => {
          setParams(current => {
            const next = new URLSearchParams(current)
            next.delete('staffing')
            next.delete('dayOffShift')
            next.delete('reportAbsence')
            next.delete('changeShift')
            next.delete('proposeShift')
            next.delete('proposalDate')
            return next
          }, { replace: true })
          close()
        }} />}
    </AnimatedOverlay>}
    {editingRequest && <AnimatedOverlay variant="modal" onClose={() => setEditingRequest(null)}>
      {(close) => <RequestForm
        organization={organization}
        request={editingRequest}
        onClose={close} />}
    </AnimatedOverlay>}
    {selectedId && <AnimatedOverlay variant="modal" onClose={closeRequest}>
      {() => <RequestDrawer
        organization={organization}
        requestId={selectedId}
        scope={scope}
        onEdit={(item) => {
          closeRequest()
          setEditingRequest(item)
        }}
        onClose={closeRequest} />}
    </AnimatedOverlay>}
  </RequestsWorkspace>
}
