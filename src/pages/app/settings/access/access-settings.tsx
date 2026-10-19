import { accessGroups, accessModules, permissionHints } from './access-presentation.ts'
import MemberProfileLink from '../../../../component/ui/member-profile-link.tsx'
import MemberAvatar from '../../../../component/ui/member-avatar.tsx'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { browsePermissionKeys, crossPointPermissionKeys, permissionCatalog } from '../../../../app/access/catalog.ts'
import { useAccessRoles, useMemberAccess, type AccessRole, type MemberAccess } from '../../../../app/access/queries.ts'
import { locationTone } from '../../../../app/organizations/format.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import Select from '../../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../../component/ui/segmented-nav/segmented-nav.tsx'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import DocumentActionsMenu from '../../documents/document-actions-menu.tsx'
import RoleEditor from './access-role-editor.tsx'
import { AccessIcon, AccessNote } from './access-elements.tsx'
import './access-settings.scss'

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось сохранить изменения.'
const auditLabels: Record<string, string> = { MEMBER_EXCLUDED: 'Сотрудник исключён из организации', MEMBER_LOCATION_REMOVED: 'Сотрудник убран из точки', ROLE_CREATED: 'Роль создана', ROLE_UPDATED: 'Права роли изменены', ROLE_DELETED: 'Роль удалена', ASSIGNMENTS_UPDATED: 'Назначения изменены', DOCUMENT_ACCESS: 'Доступ к документу изменён', FOLDER_ACCESS: 'Доступ к папке изменён' }

export default function AccessSettings({ organization }: { organization: OrganizationSummary }) {
  const org = organization.id
  const roles = useAccessRoles(org)
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState<AccessRole | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccessRole | null>(null)
  const [replacement, setReplacement] = useState('')
  const [showAudit, setShowAudit] = useState(false)
  const [search, setSearch] = useState('')
  const audit = useQuery({
    queryKey: ['access-audit', org],
    queryFn: () => apiRequest<{ entries: Array<{ id: string; action: string; details: { name?: string; memberId?: string }; createdAt: string }> }>(`/organizations/${org}/access/audit`),
    enabled: showAudit,
  })
  const remove = useMutation({
    mutationFn: () => apiRequest(`/organizations/${org}/access/roles/${deleting!.id}`, { method: 'DELETE', body: { replacementId: replacement } }),
    onSuccess: async () => { setDeleting(null); await client.invalidateQueries(); toast('Роль удалена, назначения заменены.', 'success') },
  })
  const allRoles = roles.data?.roles ?? []
  const visibleRoles = allRoles.filter(role => `${role.name} ${role.description}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))

  if (editing) return <RoleEditor org={org} role={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />

  return <div className="access-settings">
    <section className="access-card access-roles-card">
      <div className="access-heading">
        <div className="access-heading__identity"><span className="access-tile"><AccessIcon name="shield" /></span><div><h2>Роли и доступ</h2><p>Настройте возможности сотрудников и области их действия.</p></div></div>
        <button className="app-primary" onClick={() => setEditing('new')}><AccessIcon name="plus" />Создать роль</button>
      </div>
      <div className="access-toolbar">
        <div className="access-role-totals"><span>Все роли <b>{allRoles.length}</b></span><span>Свои роли <b>{allRoles.filter(role => !role.systemCode).length}</b></span></div>
        <label className="access-search"><AccessIcon name="search" /><input type="search" aria-label="Поиск ролей" placeholder="Найти роль" value={search} onChange={event => setSearch(event.target.value)} /></label>
      </div>
      {roles.isLoading ? <div className="access-empty">Загружаем роли…</div> : roles.isError ? <div className="app-alert app-alert--error">{errorText(roles.error)} <button onClick={() => void roles.refetch()}>Повторить</button></div> : <div className="access-table-wrap">
        <table className="access-table access-roles-table"><thead><tr><th scope="col">Роль</th><th scope="col">Тип роли</th><th scope="col">Сотрудники</th><th scope="col"><span className="access-sr-only">Действия</span></th></tr></thead>
          <tbody>{visibleRoles.map(role => <tr key={role.id}>
            <td><div className="access-role-name"><span className={`access-tile access-tile--${role.systemCode === 'OWNER' ? 'owner' : role.systemCode ? 'neutral' : 'custom'}`}><AccessIcon name={role.systemCode === 'OWNER' ? 'crown' : role.systemCode === 'ADMIN' ? 'shield' : 'people'} /></span><div><strong>{role.name}</strong><small>{role.description || 'Собственный набор прав для вашей команды'}</small></div></div></td>
            <td><span className={`access-tag${role.systemCode === 'OWNER' ? ' access-tag--owner' : !role.systemCode ? ' access-tag--custom' : ''}`}>{role.systemCode === 'OWNER' ? <><AccessIcon name="lock" />Защищённая</> : role.systemCode ? 'Стандартная' : 'Своя роль'}</span></td>
            <td><span className="access-member-count"><AccessIcon name="people" />{role.memberCount}</span></td>
            <td><div className="access-row-actions"><button className="access-open-role" aria-label={`${role.systemCode === 'OWNER' ? 'Посмотреть' : 'Настроить'} роль «${role.name}»`} onClick={() => setEditing(role)}>{role.systemCode === 'OWNER' ? 'Посмотреть' : 'Настроить'}<AccessIcon name="shield" /></button>{!role.systemCode && <DocumentActionsMenu label={`Действия с ролью «${role.name}»`}><button className="is-danger" onClick={() => { remove.reset(); setReplacement(''); setDeleting(role) }}><AccessIcon name="trash" />Удалить роль</button></DocumentActionsMenu>}</div></td>
          </tr>)}</tbody>
        </table>{!visibleRoles.length && <div className="access-empty"><AccessIcon name="search" /><strong>Роли не найдены</strong><p>Попробуйте другое название или описание.</p></div>}
      </div>}
      <div className="access-card-footnote"><AccessIcon name="lock" /><span>Владелец всегда сохраняет полный доступ. Стандартные роли нельзя удалить.</span></div>
    </section>

    <div className="access-explainer-grid">
      <article className="access-explainer"><span className="access-tile access-tile--rose"><AccessIcon name="building" /></span><div><h3>Вся организация или отдельные точки</h3><p>Назначьте общую роль для всех точек или настройте доступ к каждой отдельно.</p></div></article>
      <article className="access-explainer"><span className="access-tile access-tile--teal"><AccessIcon name="people" /></span><div><h3>Должность и доступ — отдельно</h3><p>Бухгалтеру можно открыть отчёты, сохранив ограничения на изменение расписания.</p></div></article>
    </div>

    <section className="access-card access-history">
      <button className="access-history__toggle" aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}><span className="access-tile access-tile--neutral"><AccessIcon name="history" /></span><span><strong>История изменений доступа</strong><small>Создание ролей, изменение прав и назначений</small></span><AccessIcon name="chevron" /></button>
      {showAudit && <div className="access-audit">{audit.isLoading ? <p className="access-empty">Загрузка…</p> : audit.isError ? <p className="form-inline-error">{errorText(audit.error)}</p> : !audit.data?.entries.length ? <p className="access-empty">Изменений пока нет.</p> : audit.data.entries.map(entry => <div key={entry.id}><span className="access-audit__dot" /><div><strong>{auditLabels[entry.action] ?? entry.action}</strong>{entry.details.name && <span>{entry.details.name}</span>}</div><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric' })}</time></div>)}</div>}
    </section>

    {deleting && <AnimatedOverlay variant="modal" dismissible={!remove.isPending} onClose={() => setDeleting(null)}>{close => <DocumentDialog title={`Удалить роль «${deleting.name}»`} eyebrow="Роли и доступ" className="access-dialog access-delete-dialog" onClose={close} busy={remove.isPending}>
      <AccessNote><strong>Назначения нужно заменить</strong><p>Сотрудников с этой ролью: {deleting.memberCount}. Выберите роль, которую они получат вместо неё.</p></AccessNote>
      <label className="access-field"><span>Заменить на</span><Select value={replacement} onChange={event => setReplacement(event.target.value)}><option value="">Выберите роль</option>{allRoles.filter(role => role.id !== deleting.id && role.systemCode !== 'OWNER').map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select></label>
      <p className="access-caption">Если роль используется в доступе к документам или событиям, сначала уберите её из их аудитории.</p>
      {remove.error && <p className="form-inline-error">{errorText(remove.error)}</p>}
      <footer><button className="app-secondary" disabled={remove.isPending} onClick={close}>Отмена</button><button className="app-danger" disabled={!replacement || remove.isPending} onClick={() => remove.mutate()}><AccessIcon name="trash" />{remove.isPending ? 'Удаляем…' : 'Заменить и удалить'}</button></footer>
    </DocumentDialog>}</AnimatedOverlay>}
  </div>
}

export function MemberAccessDialog({ org, memberId, onClose }: { org: string; memberId: string; onClose: () => void }) {
  const query = useMemberAccess(org, memberId)
  return <AnimatedOverlay variant="modal" onClose={onClose}>{close => <DocumentDialog title="Доступ сотрудника" eyebrow="Роли и области действия" className="access-dialog access-member-dialog" onClose={close}>{query.isLoading ? <p className="access-empty">Загружаем доступ…</p> : query.isError ? <p className="form-inline-error">{errorText(query.error)}</p> : query.data && <MemberAccessEditor key={memberId} org={org} memberId={memberId} data={query.data} onClose={close} />}</DocumentDialog>}</AnimatedOverlay>
}

function MemberAccessEditor({ org, memberId, data, onClose }: { org: string; memberId: string; data: MemberAccess; onClose: () => void }) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const toast = useToast()
  const [global, setGlobal] = useState(data.organizationRoleId ?? '')
  const [assignments, setAssignments] = useState(data.assignments)
  const [tab, setTab] = useState('assignments')
  const [point, setPoint] = useState(data.locations[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState(accessGroups[0])
  const mutation = useMutation({
    mutationFn: () => apiRequest(`/organizations/${org}/members/${memberId}/access`, { method: 'PUT', body: { organizationRoleId: global || null, assignments } }),
    onSuccess: async () => { await client.invalidateQueries(); toast('Назначения сотрудника сохранены.', 'success'); onClose() },
  })
  const options = data.roles.filter(role => role.systemCode !== 'OWNER')
  const assignedRoles = data.roles.filter(role => assignments.some(assignment => assignment.roleId === role.id))
  const local = data.roles.find(role => role.id === assignments.find(assignment => assignment.locationId === point)?.roleId)
  const organizationRole = data.roles.find(role => role.id === global)
  const memberName = [data.member.lastName, data.member.firstName, data.member.middleName].filter(Boolean).join(' ') || data.member.email.split('@')[0]
  const searchTerm = search.trim().toLocaleLowerCase('ru')
  const visiblePermissions = permissionCatalog.filter(permission => `${permission.group} ${permission.label} ${permissionHints[permission.key] ?? ''}`.toLocaleLowerCase('ru').includes(searchTerm))
  const visibleGroups = searchTerm ? accessGroups.filter(value => visiblePermissions.some(permission => permission.group === value)) : [group]
  function sourceFor(permission: typeof permissionCatalog[number]) {
    const inherited = assignedRoles.find(role => role.permissions.includes(permission.key))
    return organizationRole?.permissions.includes(permission.key) ? organizationRole : point && (permission.scope === 'location' && local?.permissions.includes(permission.key) || permission.key === 'locations.browse' && local?.permissions.includes(permission.key)) ? local : point && inherited && (crossPointPermissionKeys.includes(permission.key) || browsePermissionKeys.includes(permission.key) && assignedRoles.some(role => role.permissions.includes('locations.browse'))) ? inherited : undefined
  }
  return <>
    <div className="access-member-context">
      <div className="access-member-summary"><MemberAvatar memberId={memberId} url={data.member.avatarUrl} name={memberName} className="access-member-avatar" /><div><MemberProfileLink memberId={memberId}><strong>{memberName}</strong></MemberProfileLink><small>{data.member.email}</small></div><span className={`access-tag${data.owner ? ' access-tag--owner' : ''}`}>{data.owner ? 'Владелец' : 'Сотрудник'}</span></div>
      <SegmentedNav label="Доступ сотрудника"><button aria-pressed={tab === 'assignments'} onClick={() => setTab('assignments')}><AccessIcon name="pin" />Назначения</button><button aria-pressed={tab === 'effective'} onClick={() => setTab('effective')}><AccessIcon name="shield" />Итоговые права</button></SegmentedNav>
    </div>
    <div className="access-member-body">
      {data.owner ? <AccessNote protectedNote><strong>Полный доступ владельца</strong><p>Владелец имеет все права в организации. Сменить его можно на вкладке «Владение».</p></AccessNote> : tab === 'assignments' ? <div className="access-assignments">
        <section className="access-scope-card"><div className="access-section-heading"><span className="access-tile access-tile--rose"><AccessIcon name="building" /></span><div><h3>Вся организация</h3><p>Все действующие и будущие точки</p></div></div><label className="access-field"><span>Общая роль</span><Select value={global} onChange={event => setGlobal(event.target.value)}><option value="">Не назначена</option>{options.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select></label><p className="access-caption">Права общей роли действуют во всех точках и складываются с локальными.</p></section>
        <section className="access-scope-card"><div className="access-section-heading"><span className="access-tile access-tile--teal"><AccessIcon name="pin" /></span><div><h3>Роли в точках</h3><p>Отдельные возможности для каждого места работы</p></div><span className="access-tag">{assignments.length} из {data.locations.length}</span></div>
          <div className="access-points">{data.locations.map(location => <label className="access-point" key={location.id}><span><span className="access-point-icon" data-tone={locationTone(location.id)}><AccessIcon name="pin" /></span>{location.name}</span><Select aria-label={`Роль в точке «${location.name}»`} value={assignments.find(assignment => assignment.locationId === location.id)?.roleId ?? ''} onChange={event => setAssignments(previous => [...previous.filter(assignment => assignment.locationId !== location.id), ...(event.target.value ? [{ locationId: location.id, roleId: event.target.value }] : [])])}><option value="">Не назначена</option>{options.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select></label>)}</div>
          {!data.locations.length && <p className="access-caption">Нет действующих точек.</p>}
        </section>
        <AccessNote>Назначение роли не меняет должность и не добавляет сотрудника в состав точки. Новые точки включаются автоматически только при общей роли.</AccessNote>
      </div> : <div className="access-effective">
        <div className="access-effective__filters"><label className="access-field"><span>Область доступа</span><Select value={point} onChange={event => setPoint(event.target.value)}><option value="">Общие ресурсы организации</option>{data.locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></label><label className="access-search"><AccessIcon name="search" /><input type="search" aria-label="Поиск итоговых прав" placeholder="Найти действие или раздел" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
        <div className="access-effective-layout">
          <nav className="access-effective-nav" aria-label="Разделы итоговых прав">{accessGroups.map(value => {
            const items = permissionCatalog.filter(permission => permission.group === value)
            return <button key={value} type="button" aria-pressed={!searchTerm && group === value} onClick={() => { setGroup(value); setSearch('') }}><AccessIcon name={accessModules[value].icon} /><span>{value}</span><small>{items.filter(permission => sourceFor(permission)).length}/{items.length}</small></button>
          })}</nav>
          <div className="access-effective-content">{visibleGroups.map(value => <section key={value} className="access-effective-module">
            <header><AccessIcon name={accessModules[value].icon} /><div><h3>{value}</h3><p>{accessModules[value].description}</p></div></header>
            {(['location', 'organization'] as const).map(scope => {
              const items = visiblePermissions.filter(permission => permission.group === value && permission.scope === scope)
              if (!items.length) return null
              return <section key={scope}><h4>{scope === 'location' ? 'Действия в точках' : 'Общие действия организации'}</h4><div className="access-table-wrap"><table className="access-table"><thead><tr><th scope="col">Действие</th><th scope="col">Доступ</th><th scope="col">Источник</th></tr></thead><tbody>{items.map(permission => {
                const source = sourceFor(permission)
                return <tr key={permission.key}><td><strong className="access-effective__label">{permission.label}</strong></td><td><span className={`access-status${source ? ' access-status--allowed' : ''}`}>{source && <AccessIcon name="check" />}{source ? 'Разрешено' : 'Нет доступа'}</span></td><td>{source ? <span className="access-tag">{source.name}</span> : <span className="access-caption">—</span>}</td></tr>
              })}</tbody></table></div></section>
            })}
          </section>)}{!visibleGroups.length && <p className="access-empty">Действия не найдены.</p>}</div>
        </div>
        <AccessNote>Для документов дополнительно проверяется аудитория самого документа и родительских папок.</AccessNote>
      </div>}
      {mutation.error && <p className="form-inline-error">{errorText(mutation.error)}</p>}
    </div>
    <footer><button className="app-secondary" disabled={mutation.isPending} onClick={onClose}>Закрыть</button>{!data.owner && tab === 'assignments' && <button className="app-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : 'Сохранить назначения'}</button>}</footer>
  </>
}
