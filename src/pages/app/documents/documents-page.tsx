import FolderRow from './folder-row.tsx'
import ConfirmationDialog from '../../../component/ui/modal/confirmation-dialog.tsx'
import { useModuleFilters } from '../../../app/workspace/module-filters.ts'
import RequestFiles, { RequestFilesFolder } from './request-files.tsx'
import FolderBreadcrumbs from './folder-breadcrumbs.tsx'
import StorageUsage from './storage-usage.tsx'
import PageHeading from '../../../component/ui/page-heading/page-heading.tsx'
import AsyncPanel from '../../../component/ui/async-panel.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { canAccess } from '../../../app/access/catalog.ts'
import { liveQueryOptions } from '../../../app/live-query.ts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { useDocumentRefresh, useDocuments } from '../../../app/documents/queries.ts'
import type { DocumentItem, Folder } from '../../../app/documents/types.ts'
import { documentPath, sizeLabel } from '../../../app/documents/types.ts'
import Select from '../../../component/ui/select/select.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentRow from './document-row.tsx'
import { useLocations } from '../../../app/organizations/queries.ts'
import DocumentDrawer from './document-drawer.tsx'
import { AssignmentForm, DocumentForm, FolderForm } from './document-forms.tsx'
import './documents.scss'

type Dialog = { type: 'upload' } | { type: 'revision'; item: DocumentItem } | { type: 'edit'; item: DocumentItem } | { type: 'assign'; item: DocumentItem } | { type: 'delete'; item: DocumentItem } | { type: 'purge'; item: DocumentItem } | { type: 'folder'; item?: Folder } | { type: 'deleteFolder'; item: Folder }
export default function DocumentsPage({ organization }: { organization: OrganizationSummary }) {
  const toast = useToast()
  const [dialogBusy, setDialogBusy] = useState(false)
  const allowed=(key:string)=>!!organization.owner || !!organization.permissions?.includes(key) || !!organization.permissionLocations?.[key]?.length
  const manager = ['documents.upload','documents.edit','documents.delete','documents.access','documents.assign','documents.control','documents.folders','documents.personal.view'].some(allowed), { apiRequest } = useAuth(), refresh = useDocumentRefresh()
  const [params] = useSearchParams()
  const filters = useModuleFilters('documents', organization.id, { section: 'workspace', search: '', pointId: 'all', sort: 'updated', page: 1 }, { section: value => ['workspace', 'acknowledgements', 'control', 'history'].includes(String(value)), sort: value => ['updated', 'name', 'created'].includes(String(value)) })
  const [storedScope, setScope] = filters.field('section'), [search, setSearch] = filters.field('search'), [pointId, setPointId] = filters.field('pointId'), [sort, setSort] = filters.field('sort'), [page, setPage] = filters.field('page')
  const [debounced, setDebounced] = useState(search), [highlight, setHighlight] = useState(''), [dialog, setDialog] = useState<Dialog | null>(null)
  const folderId = params.get('folder') ?? '', documentId = params.get('document') ?? ''
  const systemFolder = params.get('system') === 'request-attachments'
  const scope = systemFolder ? 'workspace' : ['acknowledgements', 'control', 'history'].includes(storedScope) ? storedScope : 'workspace'
  const documents = useDocuments(organization.id, { scope, search: debounced, folderId: folderId || undefined, pointId, sort, page })
  const resources = useQuery({ ...liveQueryOptions, queryKey: ['organization-resources', organization.id], queryFn: () => apiRequest<{ storage: { usedBytes: number; limitBytes: number; archivedBytes: number; pendingDeletionBytes: number; breakdown?: Record<string, number> } }>(`/organizations/${organization.id}/resources`), enabled: canAccess(organization, 'organization.edit') })
  const usage = resources.data?.storage
  const locations = useLocations(organization.id)
  const canCreate = allowed('documents.upload') || allowed('documents.folders')
  const required = useDocuments(organization.id, { scope: 'required', pageSize: 5 })
  useEffect(() => { const timer = window.setTimeout(() => { setDebounced(search.trim()) }, 250); return () => window.clearTimeout(timer) }, [search])
  const folders = documents.data?.folders ?? [], current = folders.find(folder => folder.id === folderId)
  const breadcrumbs: Folder[] = []; let parent = current; const seen = new Set<string>(); while (parent && !seen.has(parent.id)) { breadcrumbs.unshift(parent); seen.add(parent.id); parent = folders.find(folder => folder.id === parent?.parentId) }
  const savedScroll = useRef(0), folderScroll = useRef(new Map<string, number>())
  const pendingScroll = useRef<number | null>(null)
  useLayoutEffect(() => { if (pendingScroll.current !== null && !documents.isLoading && !documentId) { window.scrollTo({ top: pendingScroll.current, behavior: 'instant' }); pendingScroll.current = null } }, [folderId, documentId, systemFolder, documents.isLoading])
  function setParam(key: string, value: string) { if (key === 'document' && value) savedScroll.current = window.scrollY; if (key === 'folder') { folderScroll.current.set(folderId, window.scrollY); pendingScroll.current = folderScroll.current.get(value) ?? 0 }; filters.patch(previous => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); return next }); if (key !== 'document') setPage(1); else if (!value) pendingScroll.current = savedScroll.current; }
  function navigateFolder(id: string) { setParam('folder', id) }
  function openRequestFiles() {
    folderScroll.current.set(folderId, window.scrollY); pendingScroll.current = 0
    filters.patch(previous => { const next = new URLSearchParams(previous); next.set('system', 'request-attachments'); next.set('section', 'workspace'); for (const key of ['folder', 'document', 'member']) next.delete(key); return next })
  }
  function closeRequestFiles() {
    pendingScroll.current = folderScroll.current.get('') ?? 0
    filters.patch(previous => { const next = new URLSearchParams(previous); next.set('section', 'workspace'); for (const key of ['system', 'attachmentSearch', 'attachmentPage', 'folder', 'document', 'member']) next.delete(key); return next })
  }
  const pin = useMutation({ mutationFn: (folder: Folder) => apiRequest(`/organizations/${organization.id}/document-folders/${folder.id}/pin`, { method: folder.pinned ? 'DELETE' : 'PUT' }), onSuccess: async (_result, folder) => { await refresh(); toast(folder.pinned ? 'Папка откреплена.' : 'Папка закреплена.') } })
  const restoration = useMutation({ mutationFn: (item: DocumentItem) => apiRequest(documentPath(organization.id, item.id) + '/restore', { method: 'POST' }), onSuccess: async () => { await refresh(); toast('Документ восстановлен. Ознакомления можно назначить заново.', 'success') } })
  const deletion = useMutation({
    mutationFn: async (value: Dialog): Promise<{ cleanupPending?: boolean }> => {
      if (value.type === 'purge') return apiRequest(`${documentPath(organization.id, value.item.id)}/content`, { method: 'DELETE', body: { confirm: true } })
      if (value.type === 'delete') await apiRequest(documentPath(organization.id, value.item.id), { method: 'DELETE' })
      else if (value.type === 'deleteFolder') await apiRequest(`/organizations/${organization.id}/document-folders/${value.item.id}`, { method: 'DELETE' })
      return {}
    },
    onSuccess: async (result, value) => {
      setDialog(null); setParam('document', ''); await refresh()
      toast(value.type === 'purge' ? result.cleanupPending ? 'Файл поставлен в очередь очистки. Квота освободится после удаления.' : 'Файл удалён навсегда. Место освобождено, история сохранена.' : 'Удалено. История документов сохранена.')
    },
  })
  function changeScope(value: string) { setScope(value); setPage(1); setPointId('all'); filters.patch(previous => { const next = new URLSearchParams(previous); next.delete('folder'); for (const key of ['system', 'attachmentSearch', 'attachmentPage']) next.delete(key); next.delete('member'); if (value !== 'workspace') next.set('section', value); else next.set('section', 'workspace'); return next }) }
  const childFolders = scope === 'workspace' && !debounced ? folders.filter(folder => folder.parentId === (folderId || null)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name, 'ru')) : []
  const systemFolders = childFolders.filter(folder => !!folder.systemKey), customFolders = childFolders.filter(folder => !folder.systemKey)
  const showRequestFiles = scope === 'workspace' && !folderId && !debounced && canAccess(organization, 'documents.view')
  const systemGroup = systemFolders.length > 0 || showRequestFiles
  const filtered = Boolean(debounced || pointId !== 'all')
  function resetFilters() { setSearch(''); setDebounced(''); setPointId('all'); setPage(1) }
  function folderPath(id: string | null) {
    const names: string[] = []; const visited = new Set<string>(); let cursor = folders.find(folder => folder.id === id)
    while (cursor && !visited.has(cursor.id)) { visited.add(cursor.id); names.unshift(cursor.name); cursor = folders.find(folder => folder.id === cursor?.parentId) }
    return ['Библиотека', ...names].join(' / ')
  }
  async function saved(id?: string) { if (id) { setPage(1); setHighlight(id); window.setTimeout(() => setHighlight(previous => previous === id ? '' : previous), 4500) }; await refresh() }
  return <section className="documents-page"><PageHeading title="Документы" description="Библиотека организации и ознакомления." actions={!systemFolder && manager && canCreate && (!current || current.canManage) && scope !== 'history' && <div className="documents-heading__actions">{scope === 'workspace' && !current?.systemKey && allowed('documents.folders') && <button className="app-secondary" onClick={() => setDialog({ type: 'folder' })}>Создать папку</button>}{allowed('documents.upload') && <button className="app-primary" onClick={() => setDialog({ type: 'upload' })}>Загрузить документ</button>}</div>} />

    {usage && <StorageUsage usage={usage} onRequests={openRequestFiles} />}
    <SegmentedNav label="Разделы документов"><button className={systemFolder || scope === 'workspace' ? 'active' : ''} onClick={() => changeScope('workspace')}>{manager ? 'Библиотека' : 'Документы организации'}</button>{allowed('documents.control') && <button className={scope === 'control' ? 'active' : ''} onClick={() => changeScope('control')}>Ознакомление</button>}{!manager && <button className={scope === 'acknowledgements' ? 'active' : ''} onClick={() => changeScope('acknowledgements')}>Требуют ознакомления{required.data?.pagination.total ? ` · ${required.data.pagination.total}` : ''}</button>}</SegmentedNav>
    {systemFolder ? <RequestFiles organization={organization} onBack={closeRequestFiles} /> : <>
    <div className="members-toolbar document-toolbar"><label><span className="document-sr-only">Поиск документов</span><input type="search" maxLength={160} placeholder={scope === 'workspace' ? 'Поиск по всей библиотеке' : 'Поиск документов'} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label><label><span className="document-sr-only">Точка документа</span><Select value={pointId} onChange={event => { setPointId(event.target.value); setParam('folder', ''); setPage(1) }}><option value="all">Все доступные точки</option><option value="shared">Общие документы</option>{locations.data?.locations.filter(point => !point.archivedAt).map(point => <option key={point.id} value={point.id}>{point.name}</option>)}</Select></label><label><span className="document-sr-only">Сортировка</span><Select value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}><option value="updated">По обновлению</option><option value="name">По названию</option><option value="created">Сначала новые</option></Select></label></div>
    {filtered && <div className="document-filter-chips">{debounced && <span>Поиск: {debounced}</span>}{pointId !== 'all' && <span>{pointId === 'shared' ? 'Общие документы' : locations.data?.locations.find(point => point.id === pointId)?.name}</span>}<button onClick={resetFilters}>Сбросить фильтры</button></div>}

    <div className="document-list-heading">{scope === 'workspace' ? <FolderBreadcrumbs currentId={folderId} items={!debounced ? breadcrumbs : []} backDisabled={documents.isFetching && !current} onNavigate={navigateFolder} onBack={() => navigateFolder(current?.parentId ?? '')} /> : <h2>{scope === 'history' ? 'Журнал удалений' : scope === 'control' ? 'Контроль ознакомлений команды' : scope === 'acknowledgements' ? 'Ваши ознакомления' : 'Документы организации'}</h2>}{allowed('documents.delete') && <button className="document-history-link" onClick={() => changeScope(scope === 'history' ? 'workspace' : 'history')}>{scope === 'history' ? 'Вернуться в библиотеку' : 'Журнал удалений'}</button>}</div>
    {restoration.error && <p className="form-inline-error" role="alert">{restoration.error.message}</p>}
    {scope === 'history' && <p className="document-history-note">Удалённые документы продолжают занимать место. Чтобы освободить его, выберите «Удалить файл навсегда» в меню документа. Документ можно восстановить, пока файл не удалён навсегда.</p>}
    {folderId && !current && scope === 'workspace' && !documents.isLoading && <p className="app-alert">Папка недоступна или удалена. Вернитесь в библиотеку.</p>}
    <AsyncPanel pending={documents.isLoading} identity={`${scope}:${page}:${folderId}:${pointId}:${debounced}:${sort}`} minHeight={320}><div className="document-list">
      {systemGroup && <section className="document-folder-group document-folder-group--system" aria-label="Системные папки"><h2>Системные папки</h2>{showRequestFiles && <RequestFilesFolder organizationId={organization.id} onOpen={openRequestFiles} />}{systemFolders.map(folder => <FolderRow key={folder.id} folder={folder} onOpen={() => navigateFolder(folder.id)} pinBusy={pin.isPending} onPin={() => pin.mutate(folder)} onEdit={manager && (folder.canEdit || folder.canAccess) ? () => setDialog({ type: 'folder', item: folder }) : undefined} onDelete={manager && folder.canDelete ? () => { deletion.reset(); setDialog({ type: 'deleteFolder', item: folder }) } : undefined} />)}</section>}
      {scope === 'workspace' && systemGroup && (customFolders.length > 0 || !!documents.data?.documents.length) && <h2 className="document-group-divider">Папки и документы организации</h2>}
      {customFolders.map(folder => <FolderRow key={folder.id} folder={folder} onOpen={() => navigateFolder(folder.id)} pinBusy={pin.isPending} onPin={() => pin.mutate(folder)} onEdit={manager && (folder.canEdit || folder.canAccess) ? () => setDialog({ type: 'folder', item: folder }) : undefined} onDelete={manager && folder.canDelete ? () => { deletion.reset(); setDialog({ type: 'deleteFolder', item: folder }) } : undefined} />)}
      {!documents.isLoading && !documents.isError && !!documents.data?.documents.length && <div className="document-list-columns" aria-hidden="true"><span>Документ</span><span>Доступ</span><span>Ознакомление</span><span>Обновлён</span><span /></div>}
      {documents.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем документы…</div> : documents.isError ? <div className="app-state" role="alert"><p>{documents.error.message}</p><button className="app-secondary" onClick={() => void documents.refetch()}>Повторить</button></div> : documents.data?.documents.length ? documents.data.documents.map(item => <DocumentRow key={item.id} item={item} acknowledgementHighlight={scope === 'acknowledgements'} columns highlighted={item.id === highlight} path={debounced ? folderPath(item.folderId) : undefined} onOpen={() => setParam('document', item.id)} onEdit={manager && (item.canEdit || item.canAccess) && !item.deletedAt ? () => setDialog({ type: 'edit', item }) : undefined} onAssign={manager && item.canAssign && !item.deletedAt ? () => setDialog({ type: 'assign', item }) : undefined} onRestore={item.canRestore ? () => restoration.mutate(item) : undefined} onPurge={manager && item.canPurge ? () => { deletion.reset(); setDialog({ type: 'purge', item }) } : undefined} onDelete={manager && item.canDelete && !item.deletedAt ? () => { deletion.reset(); setDialog({ type: 'delete', item }) } : undefined} />) : scope === 'workspace' && (childFolders.length > 0 || showRequestFiles) ? null : <div className="app-state"><p>{filtered ? 'Документы не найдены.' : scope === 'control' ? 'Все назначенные ознакомления завершены.' : scope === 'acknowledgements' ? 'Документов для ознакомления пока нет.' : scope === 'history' ? 'Удалённых документов нет.' : folderId ? 'В этой папке пока нет документов.' : childFolders.length ? 'В этом разделе нет файлов. Откройте папку или загрузите документ.' : 'Добавьте первый документ.'}</p>{filtered ? <button className="app-secondary" onClick={resetFilters}>Сбросить фильтры</button> : manager && canCreate && (!current || current.canManage) && scope === 'workspace' && <button className="app-secondary" onClick={() => setDialog({ type: 'upload' })}>{folderId ? 'Загрузить в эту папку' : 'Загрузить документ'}</button>}</div>}
    </div>
    {documents.data && documents.data.pagination.pages > 1 && <div className="document-pagination"><button className="app-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Назад</button><span>{page}/{documents.data.pagination.pages} · {documents.data.pagination.total} документов</span><button className="app-secondary" disabled={page === documents.data.pagination.pages} onClick={() => setPage(page + 1)}>Далее</button></div>}</AsyncPanel>
    </>}
    {documentId && !dialog && <AnimatedOverlay variant="modal" className="document-viewer-overlay" onClose={() => setParam('document', '')}>{close => <DocumentDrawer key={documentId} organizationId={organization.id} documentId={documentId} manager={manager} folders={folders} onClose={close} onRevision={item => setDialog({ type: 'revision', item })} onEdit={item => setDialog({ type: 'edit', item })} onAssign={item => setDialog({ type: 'assign', item })} onPurge={item => { deletion.reset(); setDialog({ type: 'purge', item }) }} onDelete={item => { deletion.reset(); setDialog({ type: 'delete', item }) }} />}</AnimatedOverlay>}
    {dialog && <AnimatedOverlay variant="modal" dismissible={!deletion.isPending && !dialogBusy} onClose={() => setDialog(null)}>{close => dialog.type === 'upload' || dialog.type === 'edit' || dialog.type === 'revision' ? <DocumentForm organizationId={organization.id} folders={folders} folderId={folderId} item={dialog.type === 'edit' ? dialog.item : undefined} revision={dialog.type === 'revision' ? dialog.item : undefined} onClose={close} onSaved={saved} uploadMaxBytes={documents.data?.uploadMaxBytes} onBusy={setDialogBusy} /> : dialog.type === 'assign' ? <AssignmentForm item={dialog.item} onClose={close} onSaved={refresh} onBusy={setDialogBusy} /> : dialog.type === 'folder' ? <FolderForm organizationId={organization.id} folders={folders} parentId={folderId} item={dialog.item} onClose={close} onSaved={refresh} onBusy={setDialogBusy} /> : <ConfirmationDialog title={dialog.type === 'purge' ? 'Удалить файл навсегда?' : dialog.type === 'delete' ? 'Удалить документ?' : 'Удалить папку?'} resource={dialog.type === 'deleteFolder' ? dialog.item.name : dialog.type === 'purge' ? dialog.item.fileName : dialog.item.displayName} description={dialog.type === 'purge' ? `Файл будет удалён без возможности восстановления. Освободится ${sizeLabel(dialog.item.size)}. История документа сохранится.` : dialog.type === 'delete' ? 'Документ переместится в журнал удалений. Незавершённые ознакомления будут отменены.' : 'Можно удалить только пустую папку. Документы и вложенные папки нужно сначала перенести.'} requiredText={dialog.type === 'deleteFolder' ? dialog.item.name : dialog.type === 'purge' ? dialog.item.fileName : undefined} confirmLabel={dialog.type === 'purge' ? 'Удалить навсегда' : dialog.type === 'deleteFolder' ? 'Удалить папку' : 'Удалить документ'} pendingLabel="Удаляем…" busy={deletion.isPending} error={deletion.error?.message} onClose={close} onConfirm={() => deletion.mutate(dialog)} />}</AnimatedOverlay>}
  </section>
}
