import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useDocumentMembers } from '../../../app/documents/queries.ts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Recipient } from '../../../app/documents/types.ts'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Select from '../../../component/ui/select/select.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import type { DocumentItem, Folder, Visibility } from '../../../app/documents/types.ts'
import { documentPath, sizeLabel, visibilityLabels } from '../../../app/documents/types.ts'
import DocumentDialog from './document-dialog.tsx'

export function DocumentForm({ organizationId, folders, folderId, item, revision, onClose, onSaved, targetMemberId, onBusy, uploadMaxBytes, personal = false }: { organizationId: string; folders: Folder[]; folderId: string; item?: DocumentItem; revision?: DocumentItem; targetMemberId?: string; onClose: () => void; onSaved: (id?: string) => Promise<unknown>; uploadMaxBytes?: number; personal?: boolean; onBusy: (busy: boolean) => void }) {
  const { apiRequest, uploadFile } = useAuth(); const toast = useToast(); const fileInput = useRef<HTMLInputElement>(null)
  const members = useDocumentMembers(organizationId)
  const initial = item ?? revision
  const [file, setFile] = useState<File | null>(null), [name, setName] = useState(initial?.displayName ?? '')
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? (targetMemberId || personal ? 'PRIVATE_MEMBER' : 'ORGANIZATION'))
  const [target, setTarget] = useState(initial?.targetMemberId ?? targetMemberId ?? ''), [folder, setFolder] = useState(initial ? initial.folderId ?? '' : folderId)
  const [assignAfterUpload, setAssignAfterUpload] = useState(false), [created, setCreated] = useState<DocumentItem | null>(null), [uploadedId, setUploadedId] = useState(''), [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  function chooseFile(selected: File | null) {
    setError('')
    if (selected && uploadMaxBytes && selected.size > uploadMaxBytes) { setError(`Размер файла превышает ${sizeLabel(uploadMaxBytes)}.`); return }
    if (uploadedId) return
    setFile(selected);
    if (selected && (!name || name === file?.name)) setName(selected.name)
    if (fileInput.current) fileInput.current.value = ''
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('')
    try {
      const data = { displayName: name.trim(), visibility, targetMemberId: visibility === 'PRIVATE_MEMBER' ? target || null : null, folderId: folder || null }
      if (item) await apiRequest(documentPath(organizationId, item.id), { method: 'PATCH', body: data })
      else {
        if (!file) throw new Error('Выберите файл.')
        const query = new URLSearchParams({ displayName: data.displayName, visibility }); if (data.folderId) query.set('folderId', data.folderId); if (data.targetMemberId) query.set('targetMemberId', data.targetMemberId)
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
    {!item && <div className={`document-file-picker${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) { if (event.dataTransfer.files.length !== 1) setError('Перетащите один файл.'); else chooseFile(event.dataTransfer.files[0]) } }}><input ref={fileInput} type="file" hidden tabIndex={-1} accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp,.ppt,.pptx" disabled={busy || Boolean(uploadedId)} onChange={event => chooseFile(event.target.files?.[0] ?? null)} />{file ? <><span className="document-row__format" aria-hidden="true">{file.name.split('.').at(-1)?.toUpperCase()}</span><strong>{file.name}</strong><small>{sizeLabel(file.size)}</small><div className="image-upload__actions"><button type="button" className="app-secondary" disabled={busy || Boolean(uploadedId)} onClick={() => fileInput.current?.click()}>Выбрать другой</button><button type="button" className="app-secondary" disabled={busy || Boolean(uploadedId)} onClick={() => chooseFile(null)}>Убрать файл</button></div></> : <><span>Перетащите файл сюда или</span><button type="button" className="app-secondary" disabled={busy || Boolean(uploadedId)} onClick={() => fileInput.current?.click()}>Выберите файл</button></>}<small>PDF, Office, CSV, TXT и изображения.{uploadMaxBytes ? ` До ${sizeLabel(uploadMaxBytes)} на файл.` : ''}</small></div>}

    <label><span>Название</span><input value={name} required maxLength={255} disabled={busy || Boolean(uploadedId)} onChange={event => setName(event.target.value)} /></label>
    <label><span>Кто сможет видеть документ</span><Select value={visibility} disabled={busy || Boolean(uploadedId)} onChange={event => setVisibility(event.target.value as Visibility)}>{Object.entries(visibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><small>{visibility === 'ORGANIZATION' ? 'Все действующие сотрудники организации.' : visibility === 'ADMINS' ? 'Только владелец и администраторы организации.' : 'Выбранный сотрудник, владелец и администраторы.'}</small></label>
    {visibility === 'PRIVATE_MEMBER' && <label><span>Сотрудник</span><Select required searchable disabled={busy || Boolean(uploadedId) || members.isLoading} value={target} onChange={event => setTarget(event.target.value)}><option value="">Выберите сотрудника</option>{members.data?.members.map(member => <option value={member.id} key={member.id} data-search={`${member.name} ${member.email}`}>{member.name}{member.former ? ' · бывший сотрудник' : ''}</option>)}</Select>{members.isError && <small role="alert">Не удалось загрузить сотрудников. <button type="button" onClick={() => void members.refetch()}>Повторить</button></small>}<small>Документ видят этот сотрудник, владелец и администраторы.</small></label>}
    {folders.length > 0 && <label><span>Папка</span><Select value={folder} disabled={busy || Boolean(uploadedId)} onChange={event => setFolder(event.target.value)}><option value="">{visibility === 'PRIVATE_MEMBER' && !item ? 'Автоматически: папка сотрудника' : 'Без папки'}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>}
    {!item && <label className="document-checkbox"><input type="checkbox" disabled={busy || Boolean(uploadedId)} checked={assignAfterUpload} onChange={event => setAssignAfterUpload(event.target.checked)} /><span>Назначить обязательное ознакомление после загрузки</span></label>}
    {!item && assignAfterUpload && <p className="request-form-note">Следующим шагом выберите получателей. Загруженный документ сохранится, даже если вы отложите назначение.</p>}
    {item && <p className="request-form-note">Сейчас документ доступен: {visibilityLabels[item.visibility]}{item.targetMember ? ` · ${item.targetMember.name}` : ''}. Незавершённые ознакомления нужно отменить перед ограничением доступа получателей.</p>}
    {item && <p className="request-form-note">Файл не заменяется. Новую редакцию загрузите отдельным документом.</p>}
    {busy && !item && <p className="document-upload-pending" role="status"><span className="app-spinner" />Загружаем и проверяем файл…</p>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{uploadedId && !busy ? 'Продолжить назначение' : busy ? item ? 'Сохраняем…' : 'Загружаем…' : item ? 'Сохранить' : assignAfterUpload ? 'Загрузить и продолжить' : 'Загрузить'}</button></footer>
  </form></DocumentDialog>
}
export function AssignmentForm({ item, onClose, onSaved, onBusy }: { item: DocumentItem; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { apiRequest } = useAuth(); const toast = useToast(); const members = useDocumentMembers(item.organizationId)
  const path = documentPath(item.organizationId, item.id)
  const current = useQuery({ queryKey: ['document-assignment-edit', item.organizationId, item.id], queryFn: async () => {
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
  const canReceive = (id: string) => item.visibility !== 'PRIVATE_MEMBER' || item.targetMemberId === id
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
    {current.isLoading ? <p className="app-state">Загружаем текущих получателей…</p> : current.isError ? <p role="alert">Не удалось загрузить получателей. <button type="button" className="app-secondary" onClick={() => void current.refetch()}>Повторить</button></p> : <fieldset><legend>Сотрудники · выбрано {selected.length}</legend><input type="search" className="staffly-control" placeholder="Поиск сотрудника" aria-label="Поиск получателя" value={search} onChange={event => setSearch(event.target.value)} /><div className="document-recipient-picker">{members.isLoading ? <p>Загружаем сотрудников…</p> : members.isError ? <p role="alert">Не удалось загрузить сотрудников. <button type="button" onClick={() => void members.refetch()}>Повторить</button></p> : members.data?.members.filter(member => !member.former && canReceive(member.id) && `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase())).map(member => { const assigned = current.data?.find(recipient => recipient.member.id === member.id); return <label className="document-checkbox" key={member.id}><input type="checkbox" disabled={busy || Boolean(assigned?.acknowledgedAt || assigned?.cancelledAt)} checked={selected.includes(member.id)} onChange={() => setSelected(previous => previous.includes(member.id) ? previous.filter(id => id !== member.id) : [...previous, member.id])} /><Avatar className="app-avatar document-avatar" url={member.avatarUrl} name={member.name} /><span>{member.name}{assigned?.acknowledgedAt ? ' · уже ознакомлен' : assigned?.cancelledAt ? ' · назначение отменено' : assigned ? ' · назначено' : ''}</span></label> })}</div></fieldset>}
    {pendingRemoval.length > 0 && <p className="request-form-note">Будет отменено: {pendingRemoval.length}. История назначений сохранится.</p>}
    {pendingAddition.length > 0 && <label><span>Комментарий для новых получателей · необязательно</span><textarea rows={3} maxLength={1000} disabled={busy} value={comment} onChange={event => setComment(event.target.value)} /></label>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button type="button" className="app-secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy || !initialized || !members.data || (!pendingAddition.length && !pendingRemoval.length)}>{busy ? 'Сохраняем…' : 'Сохранить получателей'}</button></footer>
  </form></DocumentDialog>
}
export function FolderForm({ organizationId, folders, parentId, item, onClose, onSaved, onBusy }: { organizationId: string; folders: Folder[]; parentId: string; item?: Folder; onClose: () => void; onSaved: () => Promise<unknown>; onBusy: (busy: boolean) => void }) {
  const { apiRequest } = useAuth(); const toast = useToast(); const [name, setName] = useState(item?.name ?? ''), [parent, setParent] = useState(item ? item.parentId ?? '' : parentId), [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const forbidden = new Set(item ? [item.id] : []); let changed = true; while (changed) { changed = false; folders.forEach(folder => { if (folder.parentId && forbidden.has(folder.parentId) && !forbidden.has(folder.id)) { forbidden.add(folder.id); changed = true } }) }
  async function submit(event: FormEvent) { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); try { await apiRequest(`/organizations/${organizationId}/document-folders${item ? '/' + item.id : ''}`, { method: item ? 'PATCH' : 'POST', body: { name, parentId: parent || null } }); await onSaved(); toast('Папка сохранена.'); onClose() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить папку.') } finally { lock.current = false; setBusy(false) } }
  return <DocumentDialog busy={busy} title={item ? 'Изменить папку' : 'Создать папку'} onClose={onClose}><form className="document-folder-form" onSubmit={submit}><label><span>Название</span><input required maxLength={160} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label><label><span>Расположение</span><Select disabled={busy} value={parent} onChange={event => setParent(event.target.value)}><option value="">Основной раздел</option>{folders.filter(folder => !forbidden.has(folder.id)).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>{error && <p className="form-inline-error" role="alert">{error}</p>}<footer><button className="app-secondary" type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></footer></form></DocumentDialog>
}
