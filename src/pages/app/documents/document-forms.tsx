import MemberAvatar from '../../../component/ui/member-avatar.tsx'
import { documentAccept } from '../../../app/file-preview/formats.ts'
import FilePicker from '../../../component/ui/file-picker/file-picker.tsx'
import { useAccessRoles } from '../../../app/access/queries.ts'
import DocumentAudience, { type Audience } from './document-audience.tsx'
import { useLocations, useOrganization } from '../../../app/organizations/queries.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useDocumentMembers } from '../../../app/documents/queries.ts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Recipient } from '../../../app/documents/types.ts'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Select from '../../../component/ui/select/select.tsx'
import type { DocumentItem, Folder, Visibility } from '../../../app/documents/types.ts'
import { documentPath, sizeLabel, visibilityLabels } from '../../../app/documents/types.ts'
import DocumentDialog from './document-dialog.tsx'

export function DocumentForm({ organizationId, folders, folderId, item, revision, onClose, onSaved, targetMemberId, onBusy, uploadMaxBytes, personal = false }: { organizationId: string; folders: Folder[]; folderId: string; item?: DocumentItem; revision?: DocumentItem; targetMemberId?: string; onClose: () => void; onSaved: (id?: string) => Promise<unknown>; uploadMaxBytes?: number; personal?: boolean; onBusy: (busy: boolean) => void }) {
  const { apiRequest, uploadFile } = useAuth(); const toast = useToast();
  const organization = useOrganization(organizationId)
  const owner = (organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared'))
  const points = useLocations(organizationId)
  const [pointId, setPointId] = useState((item ?? revision) ? (item ?? revision)!.locationId ?? '' : folderId ? folders.find(folder => folder.id === folderId)?.locationId ?? '' : (points.data?.locations.find(point=>!point.archivedAt && point.permissions?.includes('documents.upload'))?.id ?? organization.data?.organization.locationId) ?? '')
  const shared = !pointId
  const allowed = (key:string) => Boolean(organization.data?.organization.owner || (pointId ? points.data?.locations.find(p=>p.id===pointId)?.permissions?.includes(key) : organization.data?.organization.organizationPermissions?.includes('documents.shared') && organization.data?.organization.organizationPermissions?.includes(key)))
  useEffect(() => { if (!item && !revision && !folderId && points.isSuccess && !owner && !points.data.locations.some(p=>p.id===pointId && p.permissions?.includes('documents.upload'))) setPointId(points.data.locations.find(p=>!p.archivedAt && p.permissions?.includes('documents.upload'))?.id ?? pointId) },[item,revision,folderId,points.isSuccess,points.data,owner,pointId])
  const members = useDocumentMembers(organizationId, true, shared, pointId)
  const initial = item ?? revision
  const [file, setFile] = useState<File | null>(null), [name, setName] = useState(initial?.displayName ?? '')
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? (targetMemberId || personal ? 'PRIVATE_MEMBER' : 'ORGANIZATION'))
  const [audience,setAudience] = useState<Audience>({audienceRoleIds:initial?.audienceRoleIds??[],audienceMemberIds:initial?.audienceMemberIds??[],inheritAccess:initial?.inheritAccess??!!folderId})
  const [target, setTarget] = useState(initial?.targetMemberId ?? targetMemberId ?? ''), [folder, setFolder] = useState(initial ? initial.folderId ?? '' : folderId)
  const [assignAfterUpload, setAssignAfterUpload] = useState(false), [created, setCreated] = useState<DocumentItem | null>(null), [uploadedId, setUploadedId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  function chooseFile(selected: File | null) {
    setError('')
    if (selected && uploadMaxBytes && selected.size > uploadMaxBytes) { setError(`Размер файла превышает ${sizeLabel(uploadMaxBytes)}.`); return }
    if (uploadedId) return
    setFile(selected);
    if (selected && (!name || name === file?.name)) setName(selected.name)
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('')
    try {
      const data = { ...audience, inheritAccess: visibility !== 'PRIVATE_MEMBER' && !!folder && audience.inheritAccess, pointId: pointId || null, shared, displayName: name.trim(), visibility, targetMemberId: visibility === 'PRIVATE_MEMBER' ? target || null : null, folderId: folder || null }
      if (item) await apiRequest(documentPath(organizationId, item.id), { method: 'PATCH', body: data })
      else {
        if (!file) throw new Error('Выберите файл.')
        const query = new URLSearchParams({ displayName: data.displayName, visibility, pointId: pointId || 'shared', shared: String(shared) }); query.set('audienceRoleIds',data.audienceRoleIds.join(',')); query.set('audienceMemberIds',data.audienceMemberIds.join(',')); query.set('inheritAccess',String(data.inheritAccess)); if (data.folderId) query.set('folderId', data.folderId); if (data.targetMemberId) query.set('targetMemberId', data.targetMemberId)
        const id = uploadedId || (await uploadFile<{ document: { id: string } }>(`${documentPath(organizationId)}?${query}`, file)).document.id
        setUploadedId(id)
        await onSaved(id); toast('Документ загружен.')
        if (assignAfterUpload) { const detail = await apiRequest<{ document: DocumentItem }>(documentPath(organizationId, id)); setCreated(detail.document); return }
        onClose(); return
      }
      await onSaved(); toast(item ? 'Документ сохранён.' : 'Документ загружен.'); onClose()
    } catch (failure) { setError((uploadedId ? 'Документ уже загружен. Повторите переход к назначению. ' : '') + (failure instanceof Error ? failure.message : 'Не удалось сохранить документ.')) } finally { lock.current = false; setBusy(false) }
  }
  if (created) return <AssignmentForm item={created} onClose={onClose} onSaved={onSaved} onBusy={onBusy} />
  return <DocumentDialog busy={busy} title={item ? 'Параметры документа' : revision ? 'Новая редакция документа' : 'Загрузить документ'} onClose={onClose}><form onSubmit={submit}>
    {revision && <p className="request-form-note">Новая редакция сохранится отдельным документом. Прежний файл и его история ознакомления сохранятся; для новой редакции ознакомление назначается заново.</p>}
    {!item && <FilePicker label={revision ? 'Новая редакция' : 'Файл документа'} value={file ? [file] : []} onChange={files => chooseFile(files[0] ?? null)} accept={documentAccept} maxBytes={uploadMaxBytes} disabled={busy || Boolean(uploadedId)} hint={`PDF, Word, Excel, PowerPoint, CSV, TXT, Markdown и изображения.${uploadMaxBytes ? ` До ${sizeLabel(uploadMaxBytes)} на файл.` : ''}`}/>}

    <label><span>Название</span><input value={name} required maxLength={255} disabled={busy || Boolean(uploadedId) || !!item && !item.canEdit} onChange={event => setName(event.target.value)} /></label>
    <label><span>Точка документа</span><Select value={pointId} disabled={busy || Boolean(uploadedId) || !!item && (!item.canEdit || !item.canAccess)} onChange={event => { setPointId(event.target.value); setFolder(''); setTarget('') }}>{(owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) && <option value="">Общий для организации</option>}{points.data?.locations.filter(point => !point.archivedAt && (organization.data?.organization.owner || point.id===item?.locationId || point.permissions?.includes(item?'documents.edit':'documents.upload'))).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label>
    <label><span>Кто сможет видеть документ</span><Select value={visibility} disabled={busy || Boolean(uploadedId) || !!item && !item.canAccess} onChange={event => setVisibility(event.target.value as Visibility)}>{Object.entries(visibilityLabels).filter(([value])=>value!=='PRIVATE_MEMBER' || visibility==='PRIVATE_MEMBER' || allowed('documents.personal.edit')).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><small>{visibility === 'ORGANIZATION' ? shared ? 'Все действующие сотрудники организации.' : 'Только сотрудники выбранной точки.' : visibility === 'ADMINS' ? 'Только владелец и администраторы организации.' : visibility === 'SELECTED' ? 'Выбранные роли и сотрудники с правом просмотра документов в этой области.' : 'Получатель, владелец и уполномоченные по личным документам.'}</small></label>
    <DocumentAudience organizationId={organizationId} value={audience} onChange={setAudience} pointId={pointId} folderId={folder} visibility={visibility} targetMemberId={target} disabled={busy || !!item && !item.canAccess} />
    {visibility === 'PRIVATE_MEMBER' && <label><span>Сотрудник</span><Select required searchable disabled={busy || Boolean(uploadedId) || members.isLoading || !!item && !item.canAccess} value={target} onChange={event => setTarget(event.target.value)}><option value="">Выберите сотрудника</option>{members.data?.members.map(member => <option value={member.id} key={member.id} data-search={`${member.name} ${member.email}`}>{member.name}{member.former ? ' · бывший сотрудник' : ''}</option>)}</Select>{members.isError && <small role="alert">Не удалось загрузить сотрудников. <button type="button" onClick={() => void members.refetch()}>Повторить</button></small>}<small>Документ видят получатель, владелец и отдельно уполномоченные сотрудники.</small></label>}
    {folders.length > 0 && <label><span>Папка</span><Select value={folder} disabled={busy || Boolean(uploadedId) || !!item && (!item.canEdit || !item.canAccess)} onChange={event => setFolder(event.target.value)}><option value="">{visibility === 'PRIVATE_MEMBER' && !item ? 'Автоматически: папка сотрудника' : 'Без папки'}</option>{folders.filter(folder => (folder.locationId ?? '') === pointId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>}
    {!item && allowed('documents.assign') && <label className="document-checkbox"><input type="checkbox" disabled={busy || Boolean(uploadedId)} checked={assignAfterUpload} onChange={event => setAssignAfterUpload(event.target.checked)} /><span>Назначить обязательное ознакомление после загрузки</span></label>}
    {!item && assignAfterUpload && <p className="request-form-note">Следующим шагом выберите получателей. Загруженный документ сохранится, даже если вы отложите назначение.</p>}
    {item && <p className="request-form-note">Сейчас документ доступен: {visibilityLabels[item.visibility]}{item.targetMember ? ` · ${item.targetMember.name}` : ''}. Незавершённые ознакомления нужно отменить перед ограничением доступа получателей.</p>}
    {item && <p className="request-form-note">Файл не заменяется. Новую редакцию загрузите отдельным документом.</p>}
    {busy && !item && <p className="document-upload-pending" role="status"><span className="app-spinner" />Загружаем и проверяем файл…</p>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{uploadedId && !busy ? 'Продолжить назначение' : busy ? item ? 'Сохраняем…' : 'Загружаем…' : item ? 'Сохранить' : assignAfterUpload ? 'Загрузить и продолжить' : 'Загрузить'}</button></footer>
  </form></DocumentDialog>
}
export function AssignmentForm({ item, onClose, onSaved, onBusy }: { item: DocumentItem; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { locationId, apiRequest } = useAuth(); const toast = useToast(); const members = useDocumentMembers(item.organizationId, true, item.locationId === null, item.locationId)
  const roles=useAccessRoles(item.organizationId)
  const audiencePreview=useQuery({queryKey:['document-assignment-audience',item.organizationId,item.id,item.updatedAt],queryFn:()=>apiRequest<{members:Array<{id:string;allowed:boolean}>}>(`/organizations/${item.organizationId}/documents/access-preview`,{method:'POST',body:{displayName:item.displayName,pointId:item.locationId??null,folderId:item.folderId,visibility:item.visibility,targetMemberId:item.targetMemberId,audienceRoleIds:item.audienceRoleIds??[],audienceMemberIds:item.audienceMemberIds??[],inheritAccess:item.inheritAccess??false}})})
  const path = documentPath(item.organizationId, item.id)
  const current = useQuery({ queryKey: ['document-assignment-edit', item.organizationId, item.id, locationId], queryFn: async () => {
    const recipients: Recipient[] = []
    for (let page = 1; ; page++) {
      const result = await apiRequest<{ recipients: Recipient[]; pagination: { pages: number } }>(`${path}/progress?page=${page}`)
      recipients.push(...result.recipients)
      if (page >= result.pagination.pages) break
    }
    return recipients
  } })
  const [selected, setSelected] = useState<string[]>([]), [initialized, setInitialized] = useState(false), [comment, setComment] = useState(''), [search, setSearch] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const lock = useRef(false)
  useEffect(() => { if (!initialized && current.data) { setSelected(current.data.length ? current.data.filter(recipient => !recipient.cancelledAt).map(recipient => recipient.member.id) : item.targetMemberId ? [item.targetMemberId] : []); setInitialized(true) } }, [current.data, initialized, item.targetMemberId])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const active = current.data?.filter(recipient => !recipient.cancelledAt) ?? []
  const existingIds = new Set(current.data?.map(recipient => recipient.member.id) ?? [])
  const canReceive = (id:string)=>!!audiencePreview.data?.members.some(m=>m.id===id && m.allowed)
  const pendingRemoval = active.filter(recipient => !selected.includes(recipient.member.id) && !recipient.acknowledgedAt)
  const pendingAddition = selected.filter(id => !existingIds.has(id))
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current || !initialized) return; lock.current = true; setBusy(true); setError('')
    try {
      if (pendingAddition.length) await apiRequest(`${path}/assign`, { method: 'POST', body: { recipients: 'members', memberIds: pendingAddition, roles: [], deadline: null, comment: comment || null } })
      for (const recipient of pendingRemoval) await apiRequest(`${path}/acknowledgements/${recipient.id}/cancel`, { method: 'POST' })
      await onSaved(); toast('Получатели ознакомления обновлены.'); onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось обновить получателей. Проверьте список и повторите.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <DocumentDialog busy={busy} title="Получатели ознакомления" onClose={onClose}><form onSubmit={submit}><p>{item.displayName}</p>
    {current.isLoading ? <p className="app-state">Загружаем текущих получателей…</p> : current.isError ? <p role="alert">Не удалось загрузить получателей. <button type="button" className="app-secondary" onClick={() => void current.refetch()}>Повторить</button></p> : <fieldset><legend>Сотрудники · выбрано {selected.length}</legend><div className="access-actions"><button type="button" className="app-secondary" disabled={!audiencePreview.data || busy} onClick={()=>setSelected(members.data?.members.filter(m=>!m.former&&canReceive(m.id)).map(m=>m.id)??[])}>Все с доступом</button><Select value="" aria-label="Добавить получателей по роли" disabled={busy || !audiencePreview.data} onChange={e=>setSelected(prev=>[...new Set([...prev,...(members.data?.members.filter(m=>!m.former&&canReceive(m.id)&&m.accessRoleIds.includes(e.target.value)).map(m=>m.id)??[])])])}><option value="">Добавить по роли</option>{roles.data?.roles.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</Select></div><small>Состав ознакомления фиксируется при сохранении. Доступ по роли остаётся динамическим.</small><input type="search" className="staffly-control" placeholder="Поиск сотрудника" aria-label="Поиск получателя" value={search} onChange={event => setSearch(event.target.value)} /><div className="document-recipient-picker">{members.isLoading ? <p>Загружаем сотрудников…</p> : members.isError ? <p role="alert">Не удалось загрузить сотрудников. <button type="button" onClick={() => void members.refetch()}>Повторить</button></p> : members.data?.members.filter(member => !member.former && canReceive(member.id) && `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase())).map(member => { const assigned = current.data?.find(recipient => recipient.member.id === member.id); return <div className="document-checkbox" key={member.id}><input aria-label={`Выбрать: ${member.name}`} type="checkbox" disabled={busy || Boolean(assigned?.acknowledgedAt || assigned?.cancelledAt)} checked={selected.includes(member.id)} onChange={() => setSelected(previous => previous.includes(member.id) ? previous.filter(id => id !== member.id) : [...previous, member.id])} /><MemberAvatar memberId={member.id} className="app-avatar document-avatar" url={member.avatarUrl} name={member.name} /><span>{member.name}{assigned?.acknowledgedAt ? ' · уже ознакомлен' : assigned?.cancelledAt ? ' · назначение отменено' : assigned ? ' · назначено' : ''}</span></div> })}</div></fieldset>}
    {pendingRemoval.length > 0 && <p className="request-form-note">Будет отменено: {pendingRemoval.length}. История назначений сохранится.</p>}
    {pendingAddition.length > 0 && <label><span>Комментарий для новых получателей · необязательно</span><textarea rows={3} maxLength={1000} disabled={busy} value={comment} onChange={event => setComment(event.target.value)} /></label>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy || !initialized || !members.data || (!pendingAddition.length && !pendingRemoval.length)}>{busy ? 'Сохраняем…' : 'Сохранить получателей'}</button></footer>
  </form></DocumentDialog>
}
export function FolderForm({ organizationId, folders, parentId, item, onClose, onSaved, onBusy }: { organizationId: string; folders: Folder[]; parentId: string; item?: Folder; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { apiRequest } = useAuth(); const organization = useOrganization(organizationId); const points = useLocations(organizationId); const [pointId, setPointId] = useState(item ? item.locationId ?? '' : parentId ? folders.find(folder => folder.id === parentId)?.locationId ?? '' : (points.data?.locations.find(point=>!point.archivedAt && point.permissions?.includes('documents.folders'))?.id ?? organization.data?.organization.locationId) ?? ''); const shared = !pointId; const [visibility, setVisibility] = useState(item?.visibility ?? 'ORGANIZATION'); const toast = useToast(); const [name, setName] = useState(item?.name ?? ''), [parent, setParent] = useState(item ? item.parentId ?? '' : parentId), [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  const [audience,setAudience] = useState<Audience>({audienceRoleIds:item?.audienceRoleIds??[],audienceMemberIds:item?.audienceMemberIds??[],inheritAccess:item?.inheritAccess??!!parentId})
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  useEffect(() => { if (!item && !parentId && points.isSuccess && !organization.data?.organization.owner && !points.data.locations.some(p=>p.id===pointId && p.permissions?.includes('documents.folders'))) setPointId(points.data.locations.find(p=>!p.archivedAt && p.permissions?.includes('documents.folders'))?.id ?? pointId) },[item,parentId,points.isSuccess,points.data,organization.data,pointId])
  const forbidden = new Set(item ? [item.id] : []); let changed = true; while (changed) { changed = false; folders.forEach(folder => { if (folder.parentId && forbidden.has(folder.parentId) && !forbidden.has(folder.id)) { forbidden.add(folder.id); changed = true } }) }
  async function submit(event: FormEvent) { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); try { await apiRequest(`/organizations/${organizationId}/document-folders${item ? '/' + item.id : ''}`, { method: item ? 'PATCH' : 'POST', body: { ...audience, name, parentId: parent || null, shared, pointId: pointId || null, visibility } }); await onSaved(); toast('Папка сохранена.'); onClose() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить папку.') } finally { lock.current = false; setBusy(false) } }
  return <DocumentDialog busy={busy} title={item ? 'Изменить папку' : 'Создать папку'} onClose={onClose}><form className="document-folder-form" onSubmit={submit}><label><span>Точка папки</span><Select value={pointId} disabled={busy || !!item && (!item.canEdit || !item.canAccess)} onChange={event => { setPointId(event.target.value); setParent('') }}>{(organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) && <option value="">Общая для организации</option>}{points.data?.locations.filter(point => !point.archivedAt && ((organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) || point.id === item?.locationId || point.permissions?.includes(item?'documents.edit':'documents.folders'))).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><label><span>Доступ к папке</span><Select value={visibility} disabled={busy || !!item && !item.canAccess} onChange={event => setVisibility(event.target.value as 'ORGANIZATION' | 'ADMINS' | 'SELECTED')}><option value="ORGANIZATION">{shared ? 'Все сотрудники организации' : 'Сотрудники выбранной точки'}</option><option value="SELECTED">Выбранные роли и сотрудники</option><option value="ADMINS">Владелец и назначенные администраторы</option></Select><small>Доступ распространяется на все вложенные папки и документы.</small></label><label><span>Название</span><input required maxLength={160} disabled={busy || !!item && !item.canEdit} value={name} onChange={event => setName(event.target.value)} /></label><label><span>Расположение</span><Select disabled={busy || !!item && (!item.canEdit || !item.canAccess)} value={parent} onChange={event => setParent(event.target.value)}><option value="">Основной раздел</option>{folders.filter(folder => !forbidden.has(folder.id) && (folder.locationId ?? '') === pointId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>{error && <p className="form-inline-error" role="alert">{error}</p>}<DocumentAudience organizationId={organizationId} value={audience} onChange={setAudience} pointId={pointId} folderId={parent} visibility={visibility} disabled={busy || !!item && !item.canAccess} /><footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></footer></form></DocumentDialog>
}
