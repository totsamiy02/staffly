import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { normalizePermissions, permissionCatalog, recommendedPermissions, togglePermission } from '../../app/access/catalog.ts'
import { useAccessRoles, type AccessRole } from '../../app/access/queries.ts'
import Select from '../../component/ui/select/select.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import AnimatedOverlay from './schedule/animated-overlay.tsx'
import DocumentDialog from './documents/document-dialog.tsx'
import { AccessIcon, AccessNote, AccessPermission } from './access-elements.tsx'
import { accessGroups as groups, accessModules, permissionHints } from './access-presentation.ts'


export default function RoleEditor({ org, role, onClose }: { org: string; role?: AccessRole; onClose: () => void }) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const toast = useToast()
  const roles = useAccessRoles(org)
  const heading = useRef<HTMLDivElement>(null)
  useEffect(() => { heading.current?.scrollIntoView({ block: 'start', behavior: 'instant' }) }, [])
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? [])
  const [group, setGroup] = useState<string>(groups[0])
  const [confirm, setConfirm] = useState(false)
  const [copy, setCopy] = useState(false)
  const [template, setTemplate] = useState('')
  const [search, setSearch] = useState('')
  const protectedRole = role?.systemCode === 'OWNER'
  const existing = !!role && !copy
  const affectedMembers = role?.memberCount ?? 0
  const employeeWord = affectedMembers % 10 === 1 && affectedMembers % 100 !== 11 ? 'сотрудника' : 'сотрудников'
  const mutation = useMutation({
    mutationFn: () => apiRequest(`/organizations/${org}/access/roles${existing ? '/' + role.id : ''}`, {
      method: existing ? 'PUT' : 'POST',
      body: { name, description, permissions, ...(existing ? { revision: role.revision } : {}) },
    }),
    onSuccess: async () => { await client.invalidateQueries(); toast(existing ? 'Изменения роли сохранены.' : 'Новая роль создана.', 'success'); onClose() },
  })
  const old = role?.permissions ?? []
  const added = permissions.filter(permission => !old.includes(permission))
  const removed = old.filter(permission => !permissions.includes(permission))
  const label = (key: string) => permissionCatalog.find(permission => permission.key === key)?.label ?? key
  const searchTerm = search.trim().toLocaleLowerCase('ru')
  const visible = permissionCatalog.filter(permission => searchTerm ? `${permission.group} ${permission.label} ${permissionHints[permission.key] ?? ''}`.toLocaleLowerCase('ru').includes(searchTerm) : permission.group === group)
  const visibleGroups = searchTerm ? groups.filter(value => visible.some(permission => permission.group === value)) : [group]

  function createCopy() {
    setCopy(true)
    setName(role!.name + ' — копия')
    setConfirm(false)
    setTemplate(role!.id)
    mutation.reset()
  }

  return <div className="access-settings access-role-page">
    <div ref={heading} className="access-editor-heading">
      <button className="access-back" disabled={mutation.isPending} onClick={onClose}><AccessIcon name="back" />К списку ролей</button>
      <div className="access-heading"><div className="access-heading__identity"><span className={`access-tile${protectedRole ? ' access-tile--owner' : ''}`}><AccessIcon name={protectedRole ? 'crown' : 'shield'} /></span><div><h2>{protectedRole ? 'Роль владельца' : existing ? name : 'Новая роль'}</h2><p>{protectedRole ? 'Полный доступ к организации и всем её точкам.' : 'Выберите, что сотрудник с этой ролью сможет делать в Staffly.'}</p></div></div><span className={`access-tag${protectedRole ? ' access-tag--owner' : ''}`}>{protectedRole ? 'Защищённая роль' : role?.systemCode && !copy ? 'Стандартная роль' : 'Своя роль'}</span></div>
    </div>

    <section className="access-card access-editor-card">
      <div className="access-editor-fields">
        <label className="access-field"><span>Название роли</span><input autoFocus={!role} value={name} placeholder="Например, Бухгалтер" disabled={protectedRole || !!role?.systemCode && !copy || mutation.isPending} maxLength={80} onChange={event => setName(event.target.value)} /></label>
        <label className="access-field"><span>Описание <small>необязательно</small></span><input value={description} placeholder="Для чего нужна эта роль" disabled={protectedRole || mutation.isPending} maxLength={500} onChange={event => setDescription(event.target.value)} /></label>
        {!existing && <label className="access-field access-template"><span>Взять за основу</span><Select value={template} disabled={mutation.isPending} onChange={event => { setTemplate(event.target.value); setPermissions(roles.data?.roles.find(value => value.id === event.target.value)?.permissions ?? []) }}><option value="">Пустая роль — настроить с нуля</option>{roles.data?.roles.filter(value => value.systemCode !== 'OWNER').map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</Select><small>Копируются только права, без назначенных сотрудников.</small></label>}
      </div>

      {protectedRole && <AccessNote protectedNote><strong>Права владельца защищены</strong><p>Их нельзя изменить или отключить. Передача организации выполняется на вкладке «Владение».</p></AccessNote>}

      <div className="access-permissions-heading"><div><h3><AccessIcon name="shield" />Разрешения</h3><p>Настройте доступ по модулям и отдельным действиям.</p></div><span className="access-tag">Включено {permissions.length} из {permissionCatalog.length}</span></div>

      <div className="access-permission-editor">
        <nav aria-label="Модули разрешений"><span className="access-nav-caption">Модули</span>{groups.map(value => {
          const total = permissionCatalog.filter(permission => permission.group === value).length
          const count = permissionCatalog.filter(permission => permission.group === value && permissions.includes(permission.key)).length
          return <button type="button" aria-pressed={!searchTerm && group === value} key={value} onClick={() => { setGroup(value); setSearch('') }}><AccessIcon name={accessModules[value].icon} /><span>{value}</span><small className={count ? 'has-permissions' : ''}>{count}/{total}</small></button>
        })}<div className="access-nav-note"><AccessIcon name="info" /><p>Новые возможности выключены по умолчанию.</p></div></nav>
        <div className="access-permission-content">
          <label className="access-search"><AccessIcon name="search" /><input type="search" aria-label="Поиск разрешений" placeholder="Поиск по разрешениям" value={search} onChange={event => setSearch(event.target.value)} /></label>
          {visibleGroups.map(value => <section className="access-module" key={value}>
            <div className="access-module__heading"><span className="access-tile access-tile--neutral"><AccessIcon name={accessModules[value].icon} /></span><div><h3>{value}</h3><p>{accessModules[value].description}</p></div></div>
            {(['location', 'organization'] as const).map(scope => {
              const items = visible.filter(permission => permission.group === value && permission.scope === scope)
              if (!items.length) return null
              const enabled = items.filter(permission => permissions.includes(permission.key)).length
              return <section className="access-permission-section" key={scope}>
                <div className="access-permission-section__heading"><div><AccessIcon name={scope === 'location' ? 'pin' : 'building'} /><h4>{scope === 'location' ? 'Права в точках' : 'Общие права организации'}</h4><span>{enabled}/{items.length}</span></div>{!protectedRole && <button type="button" disabled={mutation.isPending} onClick={() => setPermissions(previous => enabled === items.length ? items.reduce((result, permission) => togglePermission(result, permission.key, false), previous) : normalizePermissions([...previous, ...items.map(permission => permission.key)]))}>{enabled === items.length ? 'Снять все' : 'Выбрать все'}</button>}</div>
                {scope === 'organization' && <p className="access-permission-section__note">{value === 'Организация и точки' ? 'Общие действия требуют назначения на всю организацию. Просмотр других точек работает и из локальной роли.' : 'Действуют при назначении роли на всю организацию.'}</p>}
                <div className="access-permission-grid">{items.map(permission => <AccessPermission key={permission.key} permission={permission} enabled={permissions.includes(permission.key)} disabled={protectedRole || mutation.isPending} onChange={enabled => setPermissions(previous => togglePermission(previous, permission.key, enabled))} />)}</div>
              </section>
            })}
          </section>)}
          {!visibleGroups.length && <div className="access-empty"><AccessIcon name="search" /><strong>Разрешения не найдены</strong><p>Попробуйте другое название действия или модуля.</p></div>}
        </div>
      </div>

      <div className="access-editor-note"><AccessIcon name="info" /><p>При включении действия автоматически добавляется нужный просмотр. Если выключить просмотр, связанные действия тоже отключатся.</p></div>
      {mutation.error && !confirm && <p className="form-inline-error">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось сохранить роль.'}</p>}
      <footer className="access-editor-footer"><div className="access-actions">{role && !protectedRole && <button className="access-text-button" disabled={mutation.isPending} onClick={createCopy}><AccessIcon name="copy" />Создать копию</button>}{role?.systemCode && !protectedRole && !copy && <button className="access-text-button" disabled={mutation.isPending} onClick={() => { setPermissions(recommendedPermissions[role.systemCode!]); mutation.reset() }}><AccessIcon name="history" />Рекомендуемые права</button>}</div><div className="access-actions"><button className="app-secondary" disabled={mutation.isPending} onClick={onClose}>{protectedRole ? 'Закрыть' : 'Отмена'}</button>{!protectedRole && <button className="app-primary" disabled={name.trim().length < 2 || mutation.isPending} onClick={() => existing ? setConfirm(true) : mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : 'Сохранить роль'}</button>}</div></footer>
    </section>

    {confirm && <AnimatedOverlay variant="modal" dismissible={!mutation.isPending} onClose={() => setConfirm(false)}>{close => <DocumentDialog title="Применить изменения роли?" eyebrow={role?.name} className="access-dialog access-confirm-dialog" onClose={close} busy={mutation.isPending}>
      <AccessNote><strong>Изменится доступ {affectedMembers} {employeeWord}</strong><p>Изменения вступят в силу во всех назначениях этой роли.</p></AccessNote>
      <div className="access-change-list">{added.map(permission => <div className="access-change access-change--added" key={permission}><span>+</span><strong>{label(permission)}</strong><small>Будет добавлено</small></div>)}{removed.map(permission => <div className="access-change access-change--removed" key={permission}><span>−</span><strong>{label(permission)}</strong><small>Будет убрано</small></div>)}{!added.length && !removed.length && <p className="access-caption">Набор прав не меняется. Будет сохранено описание роли.</p>}</div>
      {mutation.error && <p className="form-inline-error">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось сохранить роль.'}</p>}
      <footer><button className="app-secondary" disabled={mutation.isPending} onClick={close}>Вернуться к настройке</button><button className="app-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Сохраняем…' : 'Применить изменения'}</button></footer>
    </DocumentDialog>}</AnimatedOverlay>}
  </div>
}
