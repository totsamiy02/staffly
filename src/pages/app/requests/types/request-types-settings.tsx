import HelpTip from '../../../../component/ui/help-tip/help-tip.tsx'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { canAccess } from '../../../../app/access/catalog.ts'
import { definitionOf } from '../../../../app/requests/workflow.ts'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useRequestTypes } from '../../../../app/requests/queries.ts'
import type { RequestDateMode, RequestType } from '../../../../app/requests/types.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import Select from '../../../../component/ui/select/select.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import VacationSettings from '../vacations/vacation-settings.tsx'
import { WorkflowEditor } from './workflow-fields.tsx'
import '../requests.scss'
import '../requests-redesign.scss'
import './workflow.scss'

const blank = () => ({ name: '', description: '', dateMode: 'NONE' as RequestDateMode, requiresComment: false, allowsAttachments: false, definition: definitionOf({}) })

export default function RequestTypesSettings({ organization, onMessage, onError }: { organization: OrganizationSummary; onMessage: (value: string) => void; onError: (value: string) => void }) {
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const types = useRequestTypes(organization.id, true)
  const [editing, setEditing] = useState<RequestType | null>(null)
  const [deleting, setDeleting] = useState<RequestType | null>(null)
  const [form, setForm] = useState(blank)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  if (!canAccess(organization, 'requestTypes.manage')) return null
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request-types', organization.id] })
  function startEdit(type?: RequestType) {
    setEditing(type ?? null)
    setForm(type ? { name: type.name, description: type.description ?? '', dateMode: type.dateMode, requiresComment: type.requiresComment, allowsAttachments: type.allowsAttachments, definition: definitionOf(type.definition) } : blank())
    setDialogError('')
    setOpen(true)
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setDialogError(''); onError('')
    try {
      if (form.definition.stages.some(stage => !stage.memberId && !stage.roleId)) throw new Error('Выберите согласующего для каждого этапа или удалите ненужный этап.')
      if (form.definition.fields.some(field => field.kind === 'SELECT' && !field.options.length)) throw new Error('Добавьте варианты ответа для каждого вопроса со списком.')
      if (['TASK', 'NOTIFY'].includes(form.definition.action) && !form.definition.recipientMemberIds.length) throw new Error(form.definition.action === 'TASK' ? 'Выберите хотя бы одного исполнителя задачи в дополнительных настройках.' : 'Выберите хотя бы одного получателя уведомления в дополнительных настройках.')
      const body = { ...form, allowsAttachments: form.allowsAttachments || form.definition.fields.some(f => f.kind === 'FILE'), description: form.description || null, ...(editing ? { isActive: editing.isActive } : {}) }
      await apiRequest(`/organizations/${organization.id}/request-types${editing ? `/${editing.id}` : ''}`, { method: editing ? 'PATCH' : 'POST', body })
      await refresh(); setOpen(false); onMessage(editing ? 'Тип заявки обновлён.' : 'Тип заявки создан.')
    } catch (failure) { setDialogError(failure instanceof Error ? failure.message : 'Не удалось сохранить тип заявки.') }
    finally { setBusy(false) }
  }
  async function toggle(type: RequestType) {
    setBusy(true); onError('')
    try {
      await apiRequest(`/organizations/${organization.id}/request-types/${type.id}`, { method: 'PATCH', body: { name: type.name, description: type.description, dateMode: type.dateMode, requiresComment: type.requiresComment, allowsAttachments: type.allowsAttachments, isActive: !type.isActive } })
      await refresh(); onMessage(type.isActive ? 'Подача отключена. Старые заявки сохранены.' : 'Тип снова доступен для подачи.')
    } catch (failure) { onError(failure instanceof Error ? failure.message : 'Не удалось изменить тип заявки.') }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!deleting) return
    setBusy(true); setDialogError('')
    try {
      await apiRequest(`/organizations/${organization.id}/request-types/${deleting.id}`, { method: 'DELETE' })
      await refresh(); setDeleting(null); onMessage('Тип заявки удалён. Ранее созданные заявки сохранены.')
    } catch (failure) { setDialogError(failure instanceof Error ? failure.message : 'Не удалось удалить тип заявки.') }
    finally { setBusy(false) }
  }
  const system = types.data?.types.filter(type => type.systemCode) ?? []
  const custom = types.data?.types.filter(type => !type.systemCode) ?? []
  return <article className="request-types-settings">
    <header><div><p className="app-eyebrow">Заявки</p><h2>Типы заявок</h2><p>Настройте, с какими вопросами сотрудники могут обращаться. Отключение подачи сохраняет тип в этом списке; удаление пользовательского типа убирает его из настроек. Старые заявки сохраняются в обоих случаях.</p></div><button className="app-primary" onClick={() => startEdit()}>+ Создать тип</button></header>
    <VacationSettings organizationId={organization.id} canCollect={canAccess(organization, 'vacations.collect')} onMessage={onMessage} onError={onError}/>
    {types.isLoading ? <div className="app-state"><span className="app-spinner"/></div> : types.isError ? <div className="app-state"><p>Не удалось загрузить типы заявок.</p><button className="app-secondary" onClick={() => void types.refetch()}>Повторить</button></div> : <>
      <section><h3>Системные</h3>{system.map(type => <div className={`request-type-row${type.isActive ? '' : ' is-inactive'}`} key={type.id}><div><strong>{type.name}</strong><span>{type.description}</span></div><small>{type.isActive ? 'Доступен' : 'Подача отключена'}</small><button disabled={busy} onClick={() => void toggle(type)}>{type.isActive ? 'Отключить подачу' : 'Включить подачу'}</button></div>)}</section>
      <section><h3>Пользовательские</h3>{custom.length ? custom.map(type => <div className={`request-type-row${type.isActive ? '' : ' is-inactive'}`} key={type.id}><div><strong>{type.name}</strong><span>{type.description || 'Без описания'}</span></div><small>{type.isActive ? 'Доступен' : 'Подача отключена'}</small><button disabled={busy} onClick={() => startEdit(type)}>Изменить</button><button disabled={busy} onClick={() => void toggle(type)}>{type.isActive ? 'Отключить подачу' : 'Включить подачу'}</button><button className="request-type-delete" disabled={busy} onClick={() => { setDialogError(''); setDeleting(type) }}>Удалить</button></div>) : <p className="request-types-empty">Пользовательских типов пока нет. Создайте свой, если стандартных обращений недостаточно.</p>}</section>
    </>}
    {open && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setOpen(false)}>{close => <DocumentDialog title={editing ? 'Изменить тип заявки' : 'Новый тип заявки'} eyebrow="Заявки" className="request-form-dialog request-builder-dialog" busy={busy} onClose={close}>
<div className="request-builder-intro"><span>Шаблон обращения<HelpTip label="Как работает тип заявки">Сотрудник выбирает тип, заполняет вопросы и отправляет обращение на рассмотрение. Начните с названия и нужных вопросов; дополнительные настройки можно оставить по умолчанию.</HelpTip></span><Link to="/guide/request-builder" target="_blank" rel="noreferrer" aria-label="Открыть инструкцию по конструктору">Инструкция</Link></div>
      <form onSubmit={submit}>
        <label><span>Название типа</span><input autoFocus value={form.name} placeholder="Например, Покупка рабочей формы" onChange={e => setForm({ ...form, name: e.target.value })} minLength={2} maxLength={100} required/></label>
        <label><span>Подсказка для сотрудника<HelpTip label="Описание типа заявки">Необязательно. Этот текст появится при выборе типа. Объясните, когда использовать это обращение.</HelpTip></span><textarea value={form.description} placeholder="Когда выбирать этот тип и что указать в обращении" onChange={e => setForm({ ...form, description: e.target.value })} maxLength={500} rows={2}/></label>
        <details className="request-builder-disclosure" open={form.dateMode !== 'NONE' || form.requiresComment || form.allowsAttachments}><summary>Даты, комментарий и вложения<HelpTip label="О стандартных полях">Комментарий уже есть в обычной заявке. Его можно сделать обязательным, запросить даты и разрешить файлы.</HelpTip></summary><label><span>Нужно ли указать даты<HelpTip label="О датах пользовательской заявки">Например, дата получения формы. Эти даты сами по себе не меняют расписание или отсутствия.</HelpTip></span><Select value={form.dateMode} onChange={e => setForm({ ...form, dateMode: e.target.value as RequestDateMode })}><option value="NONE">Даты не нужны</option><option value="SINGLE">Одна дата</option><option value="RANGE">Начало и окончание периода</option></Select></label><label className="request-type-check"><input type="checkbox" checked={form.requiresComment} onChange={e => setForm({ ...form, requiresComment: e.target.checked })}/><span>Обязательный комментарий</span></label><label className="request-type-check"><input type="checkbox" checked={form.allowsAttachments} onChange={e => setForm({ ...form, allowsAttachments: e.target.checked })}/><span>Разрешить вложения<HelpTip label="Какие файлы можно приложить">Фото или PDF, до пяти файлов по 10 МБ.</HelpTip></span></label></details>
        <WorkflowEditor organizationId={organization.id} value={form.definition} onChange={definition => setForm({ ...form, definition })}/>
        {dialogError && <p className="form-inline-error" role="alert">{dialogError}</p>}
        <footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : editing ? 'Сохранить изменения' : 'Создать тип'}</button></footer>
      </form>
    </DocumentDialog>}</AnimatedOverlay>}
    {deleting && <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setDeleting(null)}>{close => <DocumentDialog title={`Удалить тип «${deleting.name}»?`} eyebrow="Заявки" className="request-form-dialog request-type-delete-dialog" busy={busy} onClose={close}><p>Тип исчезнет из настроек и из формы подачи. Ранее созданные заявки, их файлы и история сохранятся; их можно будет обработать.</p><p>Чтобы временно скрыть тип и позже вернуть его, используйте «Отключить подачу».</p>{dialogError && <p className="form-inline-error" role="alert">{dialogError}</p>}<footer><button className="app-secondary" disabled={busy} onClick={close}>Отмена</button><button className="app-primary" disabled={busy} onClick={() => void remove()}>{busy ? 'Удаляем…' : 'Удалить тип'}</button></footer></DocumentDialog>}</AnimatedOverlay>}
  </article>
}
