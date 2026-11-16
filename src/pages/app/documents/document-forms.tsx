import MemberBulkDialog from '../shared/member-bulk-dialog.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import OperationStatus from '../../../component/ui/operation-status.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import EmployeePicker from '../shared/employee-picker.tsx'
import { documentAccept } from '../../../app/file-preview/formats.ts'
import FilePicker from '../../../component/ui/file-picker/file-picker.tsx'
import DocumentAudience, { type Audience } from './document-audience.tsx'
import { useLocations, useOrganization } from '../../../app/organizations/queries.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useDocumentMembers } from '../../../app/documents/queries.ts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Select from '../../../component/ui/select/select.tsx'
import type { DocumentItem, Folder, Visibility } from '../../../app/documents/types.ts'
import { documentPath, sizeLabel, visibilityLabels } from '../../../app/documents/types.ts'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'

export function DocumentForm({ organizationId, folders, folderId, item, revision, onClose, onSaved, onBusy, uploadMaxBytes }: { organizationId: string; folders: Folder[]; folderId: string; item?: DocumentItem; revision?: DocumentItem; onClose: () => void; onSaved: (id?: string) => Promise<unknown>; uploadMaxBytes?: number; onBusy: (busy: boolean) => void }) {
  const { apiRequest, uploadFile } = useAuth(); const toast = useToast();
  const organization = useOrganization(organizationId)
  const owner = (organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared'))
  const points = useLocations(organizationId)
  const [pointId, setPointId] = useState((item ?? revision) ? (item ?? revision)!.locationId ?? '' : folderId ? folders.find(folder => folder.id === folderId)?.locationId ?? '' : (points.data?.locations.find(point=>!point.archivedAt && point.permissions?.includes('documents.upload'))?.id ?? organization.data?.organization.locationId) ?? '')
  const shared = !pointId
  const allowed = (key:string) => Boolean(organization.data?.organization.owner || (pointId ? points.data?.locations.find(p=>p.id===pointId)?.permissions?.includes(key) : organization.data?.organization.organizationPermissions?.includes('documents.shared') && organization.data?.organization.organizationPermissions?.includes(key)))
  const members = useDocumentMembers(organizationId, true, shared, pointId)
  const initial = item ?? revision
  const [file, setFile] = useState<File | null>(null), [name, setName] = useState(initial?.displayName ?? '')
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? 'ORGANIZATION')
  const [audience,setAudience] = useState<Audience>({audienceRoleIds:initial?.audienceRoleIds??[],audienceMemberIds:initial?.audienceMemberIds??[],inheritAccess:initial?.inheritAccess??!!folderId})
  const [target, setTarget] = useState(initial?.targetMemberId ?? ''), [folder, setFolder] = useState(initial ? initial.folderId ?? '' : folderId)
  const [assignAfterUpload, setAssignAfterUpload] = useState(false), [created, setCreated] = useState<DocumentItem | null>(null), [uploadedId, setUploadedId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  const safety = useFormSafety({ scope: 'document:' + organizationId + ':' + (initial?.id ?? 'new'), value: { name, visibility, audience, target, folder, pointId, assignAfterUpload, file: file ? { name: file.name, size: file.size, modified: file.lastModified } : null }, busy, active: !created })
  const pointInitialized = useRef(false)
  const initializeDefaults = safety.initialize
  useEffect(() => {
    if (!points.isSuccess || pointInitialized.current) return
    pointInitialized.current = true
    if (!item && !revision && !folderId && !owner && !points.data.locations.some(p=>p.id===pointId && p.permissions?.includes('documents.upload'))) {
      const selected = points.data.locations.find(p=>!p.archivedAt && p.permissions?.includes('documents.upload'))?.id ?? pointId
      initializeDefaults({ pointId: selected }); setPointId(selected)
    }
  }, [item,revision,folderId,points.isSuccess,points.data,owner,pointId,initializeDefaults])
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
        await onSaved(id); safety.markSaved(); toast('Документ загружен.')
        if (assignAfterUpload) { const detail = await apiRequest<{ document: DocumentItem }>(documentPath(organizationId, id)); setCreated(detail.document); return }
        onClose(); return
      }
      await onSaved(); safety.markSaved(); toast(item ? 'Документ сохранён.' : 'Документ загружен.'); onClose()
    } catch (failure) { setError((uploadedId ? 'Документ уже загружен. Повторите переход к назначению. ' : '') + (failure instanceof Error ? failure.message : 'Не удалось сохранить документ.')) } finally { lock.current = false; setBusy(false) }
  }
  if (created) return <AssignmentForm item={created} onClose={onClose} onSaved={onSaved} onBusy={onBusy} />
  return <DocumentDialog busy={busy} title={item ? 'Параметры документа' : revision ? 'Новая редакция документа' : 'Загрузить документ'} onClose={onClose}><form ref={safety.ref} onSubmit={submit}>
    {revision && <p className="request-form-note">Новая редакция сохранится отдельным документом. Прежний файл и его история ознакомления сохранятся; для новой редакции ознакомление назначается заново.</p>}
    {!item && <FilePicker label={revision ? 'Новая редакция' : 'Файл документа'} value={file ? [file] : []} onChange={files => chooseFile(files[0] ?? null)} accept={documentAccept} maxBytes={uploadMaxBytes} disabled={busy || Boolean(uploadedId)} hint={`PDF, Word, Excel, PowerPoint, CSV, TXT, Markdown и изображения.${uploadMaxBytes ? ` До ${sizeLabel(uploadMaxBytes)} на файл.` : ''}`}/>}

    <label><span>Название</span><input value={name} required maxLength={255} disabled={busy || Boolean(uploadedId) || !!item && !item.canEdit} onChange={event => setName(event.target.value)} /></label>
    <label><span>Точка документа</span><Select value={pointId} disabled={busy || Boolean(uploadedId) || !!item && (!item.canEdit || !item.canAccess)} onChange={event => { setPointId(event.target.value); setFolder(''); setTarget('') }}>{(owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) && <option value="">Общий для организации</option>}{points.data?.locations.filter(point => !point.archivedAt && (organization.data?.organization.owner || point.id===item?.locationId || point.permissions?.includes(item?'documents.edit':'documents.upload'))).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label>
    <label><span>Кто сможет видеть документ</span><Select value={visibility} disabled={busy || Boolean(uploadedId) || !!item && !item.canAccess} onChange={event => setVisibility(event.target.value as Visibility)}>{Object.entries(visibilityLabels).filter(([value])=>value!=='PRIVATE_MEMBER' || initial?.visibility==='PRIVATE_MEMBER').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><small>{visibility === 'ORGANIZATION' ? shared ? 'Все действующие сотрудники организации.' : 'Только сотрудники выбранной точки.' : visibility === 'ADMINS' ? 'Только владелец и администраторы организации.' : visibility === 'SELECTED' ? 'Выбранные роли и сотрудники с правом просмотра документов в этой области.' : 'Получатель, владелец и уполномоченные по личным документам.'}</small></label>
    <DocumentAudience organizationId={organizationId} value={audience} onChange={setAudience} pointId={pointId} folderId={folder} visibility={visibility} targetMemberId={target} disabled={busy || !!item && !item.canAccess} />
    {visibility === 'PRIVATE_MEMBER' && <div className="document-person-field"><EmployeePicker members={(members.data?.members ?? []).map(member => ({ id: member.id, displayName: member.name, email: member.email, avatarUrl: member.avatarUrl, secondary: member.former ? [member.email !== member.name ? member.email : '', 'Бывший сотрудник'].filter(Boolean).join(' · ') : undefined }))} disabled={busy || Boolean(uploadedId) || members.isLoading || members.isError || !!item && !item.canAccess} value={target} onChange={setTarget} />{members.isError && <small role="alert">Не удалось загрузить сотрудников. <button type="button" onClick={() => void members.refetch()}>Повторить</button></small>}<small>Документ видят получатель, владелец и отдельно уполномоченные сотрудники.</small></div>}
    {folders.length > 0 && <label><span>Папка</span><Select value={folder} disabled={busy || Boolean(uploadedId) || !!item && (!item.canEdit || !item.canAccess)} onChange={event => setFolder(event.target.value)}><option value="">{visibility === 'PRIVATE_MEMBER' && !item ? 'Автоматически: папка сотрудника' : 'Без папки'}</option>{folders.filter(folder => (folder.locationId ?? '') === pointId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>}
    {!item && allowed('documents.assign') && <label className="document-checkbox"><input type="checkbox" disabled={busy || Boolean(uploadedId)} checked={assignAfterUpload} onChange={event => setAssignAfterUpload(event.target.checked)} /><span>Назначить обязательное ознакомление после загрузки</span></label>}
    {!item && assignAfterUpload && <p className="request-form-note">Следующим шагом выберите получателей. Загруженный документ сохранится, даже если вы отложите назначение.</p>}
    {item && <p className="request-form-note">Сейчас документ доступен: {visibilityLabels[item.visibility]}{item.targetMember ? ` · ${item.targetMember.name}` : ''}. Незавершённые ознакомления нужно отменить перед ограничением доступа получателей.</p>}
    {item && <p className="request-form-note">Файл не заменяется. Новую редакцию загрузите отдельным документом.</p>}
    {busy && !item && <p className="document-upload-pending" role="status"><span className="app-spinner" />Загружаем и проверяем файл…</p>}
    <OperationStatus state={busy ? { phase: 'running', message: uploadedId ? 'Файл загружен, сохраняем результат…' : 'Загружаем и сохраняем документ…' } : error ? { phase: 'failed', message: error } : null} />
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{uploadedId && !busy ? 'Продолжить назначение' : busy ? item ? 'Сохраняем…' : 'Загружаем…' : item ? 'Сохранить' : assignAfterUpload ? 'Загрузить и продолжить' : 'Загрузить'}</button></footer>
  </form></DocumentDialog>
}
export function AssignmentForm({ item, onClose, onSaved, onBusy }: { item: DocumentItem; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  return <MemberBulkDialog
    organizationId={item.organizationId}
    target={{ kind: 'DOCUMENT', targetId: item.id }}
    onClose={onClose}
    onSaved={onSaved}
    onBusy={onBusy}
  />
}
export function FolderForm({ organizationId, folders, parentId, item, onClose, onSaved, onBusy }: { organizationId: string; folders: Folder[]; parentId: string; item?: Folder; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { apiRequest } = useAuth(); const organization = useOrganization(organizationId); const points = useLocations(organizationId); const [pointId, setPointId] = useState(item ? item.locationId ?? '' : parentId ? folders.find(folder => folder.id === parentId)?.locationId ?? '' : (points.data?.locations.find(point=>!point.archivedAt && point.permissions?.includes('documents.folders'))?.id ?? organization.data?.organization.locationId) ?? ''); const shared = !pointId; const [visibility, setVisibility] = useState(item?.visibility ?? 'ORGANIZATION'); const toast = useToast(); const [name, setName] = useState(item?.name ?? ''), [parent, setParent] = useState(item ? item.parentId ?? '' : parentId), [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  const [audience,setAudience] = useState<Audience>({audienceRoleIds:item?.audienceRoleIds??[],audienceMemberIds:item?.audienceMemberIds??[],inheritAccess:item?.inheritAccess??!!parentId})
  const safety = useFormSafety({ scope: 'document-folder:' + organizationId + ':' + (item?.id ?? 'new'), value: { name, parent, pointId, visibility, audience }, busy })
  const pointInitialized = useRef(false)
  const initializeDefaults = safety.initialize
  useEffect(() => {
    if (!points.isSuccess || pointInitialized.current) return
    pointInitialized.current = true
    if (!item && !parentId && !organization.data?.organization.owner && !points.data.locations.some(p=>p.id===pointId && p.permissions?.includes('documents.folders'))) {
      const selected = points.data.locations.find(p=>!p.archivedAt && p.permissions?.includes('documents.folders'))?.id ?? pointId
      initializeDefaults({ pointId: selected }); setPointId(selected)
    }
  }, [item,parentId,points.isSuccess,points.data,organization.data,pointId,initializeDefaults])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const forbidden = new Set(item ? [item.id] : []); let changed = true; while (changed) { changed = false; folders.forEach(folder => { if (folder.parentId && forbidden.has(folder.parentId) && !forbidden.has(folder.id)) { forbidden.add(folder.id); changed = true } }) }
  async function submit(event: FormEvent) { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); try { await apiRequest(`/organizations/${organizationId}/document-folders${item ? '/' + item.id : ''}`, { method: item ? 'PATCH' : 'POST', body: { ...audience, name, parentId: parent || null, shared, pointId: pointId || null, visibility } }); await onSaved(); safety.markSaved(); toast('Папка сохранена.'); onClose() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить папку.') } finally { lock.current = false; setBusy(false) } }
  return <DocumentDialog busy={busy} title={item?.systemKey ? 'Доступ к системной папке' : item ? 'Изменить папку' : 'Создать папку'} onClose={onClose}><form ref={safety.ref} className="document-folder-form" onSubmit={submit}><label><span>Точка папки</span><Select value={pointId} disabled={busy || !!item && (!item.canEdit || !item.canAccess)} onChange={event => { setPointId(event.target.value); setParent('') }}>{(organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) && <option value="">Общая для организации</option>}{points.data?.locations.filter(point => !point.archivedAt && ((organization.data?.organization.owner || organization.data?.organization.organizationPermissions?.includes('documents.shared')) || point.id === item?.locationId || point.permissions?.includes(item?'documents.edit':'documents.folders'))).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><label><span>Доступ к папке</span><Select value={visibility} disabled={busy || !!item && !item.canAccess} onChange={event => setVisibility(event.target.value as 'ORGANIZATION' | 'ADMINS' | 'SELECTED')}><option value="ORGANIZATION">{shared ? 'Все сотрудники организации' : 'Сотрудники выбранной точки'}</option><option value="SELECTED">Выбранные роли и сотрудники</option><option value="ADMINS">Владелец и назначенные администраторы</option></Select><small>Доступ распространяется на все вложенные папки и документы.</small></label><label><span>Название</span><input required maxLength={160} disabled={busy || !!item && !item.canEdit} value={name} onChange={event => setName(event.target.value)} /></label><label><span>Расположение</span><Select disabled={busy || !!item && (!item.canEdit || !item.canAccess)} value={parent} onChange={event => setParent(event.target.value)}><option value="">Основной раздел</option>{folders.filter(folder => !forbidden.has(folder.id) && (folder.locationId ?? '') === pointId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>{error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}<DocumentAudience organizationId={organizationId} value={audience} onChange={setAudience} pointId={pointId} folderId={parent} visibility={visibility} disabled={busy || !!item && !item.canAccess} /><footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></footer></form></DocumentDialog>
}
