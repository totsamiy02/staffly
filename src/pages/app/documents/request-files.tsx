import RequestErrorMessage, { RequestErrorState } from '../../../component/ui/request-error-message.tsx'
import ConfirmationDialog from '../../../component/ui/modal/confirmation-dialog.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useModuleFilters } from '../../../app/workspace/module-filters.ts'
import HelpTip from '../../../component/ui/help-tip/help-tip.tsx'
import FolderBreadcrumbs from './folder-breadcrumbs.tsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { liveQueryOptions } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { sizeLabel } from '../../../app/documents/types.ts'

type RequestFile = { requestId: string; canDelete: boolean; id: string; fileName: string; size: number; mimeType: string; createdAt: string; creatorName: string; typeName: string; locationName: string; requestHref: string; downloadPath: string }
type FilePage = { files: RequestFile[]; totalBytes: number; pagination: { page: number; pageSize: number; total: number; pages: number } }
function fileCount(value: number) { const form = new Intl.PluralRules('ru-RU').select(value); return `${value} ${form === 'one' ? 'файл' : form === 'few' ? 'файла' : 'файлов'}` }
function useRequestFiles(organizationId: string, page = 1, search = '') {
  const { apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['document-request-files', organizationId, page, search], queryFn: () => apiRequest<FilePage>(`/organizations/${organizationId}/documents/request-attachments?${new URLSearchParams({ page: String(page), search })}`) })
}
export function RequestFilesFolder({ organizationId, onOpen }: { organizationId: string; onOpen: () => void }) {
  const query = useRequestFiles(organizationId)
  return <article className="document-folder-row document-system-folder"><button type="button" className="document-folder-open" onClick={onOpen}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3V6Z" /></svg>
    <span className="document-system-folder__name"><strong>Вложения заявок</strong><small>{query.data ? `${fileCount(query.data.pagination.total)} · ${sizeLabel(query.data.totalBytes)}` : 'Автоматическая папка'}</small></span>
    <span className="document-system-folder__label">Системная</span>
  </button></article>
}
export default function RequestFiles({ organization, onBack }: { organization: OrganizationSummary; onBack: () => void }) {
  const filters = useModuleFilters('request-attachments', organization.id, { attachmentSearch: '', attachmentPage: 1 })
  const [search, setSearch] = filters.field('attachmentSearch'), [page, setPage] = filters.field('attachmentPage')
  const [debounced, setDebounced] = useState(search)
  const files = useRequestFiles(organization.id, page, debounced), { downloadFile, apiRequest } = useAuth()
  const [removing, setRemoving] = useState<RequestFile | null>(null), client = useQueryClient(), toast = useToast()
  const deletion = useMutation({ mutationFn: (file: RequestFile) => apiRequest(file.downloadPath, { method: 'DELETE' }), onSuccess: async () => { setRemoving(null); await Promise.all(['document-request-files', 'request', 'requests', 'organization-resources', 'notifications'].map(key => client.invalidateQueries({ queryKey: [key] }))); toast('Вложение удалено из заявки.', 'success') } })
  const download = useMutation({ mutationFn: (file: RequestFile) => downloadFile(file.downloadPath, file.fileName) })
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(search.trim()), 250); return () => window.clearTimeout(timer) }, [search])
  return <section className="request-files-page" aria-label="Вложения заявок">
    <header className="request-files-header">
      <div className="document-list-heading request-files-heading"><FolderBreadcrumbs currentId="request-attachments" items={[{ id: 'request-attachments', name: 'Вложения заявок' }]} onNavigate={id => { if (!id) onBack() }} onBack={onBack} /><span className="document-system-folder__label">Системная<HelpTip label="О системной папке">Папка создаётся автоматически. Её нельзя удалить или переименовать. Вложения можно удалять здесь или в заявке, если у вас есть право на удаление.</HelpTip></span></div>
      <p className="request-files-description">Вложения из доступных вам заявок.</p>
    </header>
    <div className="request-files-toolbar"><input aria-label="Найти вложение заявки" type="search" maxLength={160} placeholder="Название файла или тип заявки" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} /><span>{files.data ? `${fileCount(files.data.pagination.total)} · ${sizeLabel(files.data.totalBytes)}` : 'Загружаем…'}</span></div>
    {download.error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={download.error.message} /></p>}
    <div className="request-files-list">{files.isLoading ? <div className="app-state" role="status">Загружаем вложения…</div> : files.isError ? <RequestErrorState error={files.error} onRetry={() => void files.refetch()} /> : files.data?.files.map(file => <article className="request-file-row" key={file.id}><span className="document-file-kind">{file.fileName.includes('.') ? file.fileName.split('.').pop()?.slice(0, 7).toUpperCase() : 'ФАЙЛ'}</span><div className="request-file-row__name"><strong>{file.fileName}</strong><small>{sizeLabel(file.size)} · {file.creatorName}</small><Link to={file.requestHref}>{file.typeName}</Link></div><span className="request-file-row__location">{file.locationName}</span><time dateTime={file.createdAt}>{new Date(file.createdAt).toLocaleDateString('ru-RU')}</time><div className="request-file-row__actions"><button className="app-secondary" disabled={download.isPending} onClick={() => download.mutate(file)}>Скачать</button>{file.canDelete && <button className="document-action-delete" onClick={() => { deletion.reset(); setRemoving(file) }}>Удалить</button>}</div></article>)}{files.isSuccess && !files.data.files.length && <div className="app-state"><p>{debounced ? 'Вложения не найдены.' : 'В доступных вам заявках пока нет вложений.'}</p></div>}</div>
    {files.data && files.data.pagination.pages > 1 && <nav className="document-pagination" aria-label="Страницы вложений"><button className="app-secondary" disabled={files.data.pagination.page === 1} onClick={() => setPage((files.data?.pagination.page ?? page) - 1)}>Назад</button><span>{files.data.pagination.page} / {files.data.pagination.pages}</span><button className="app-secondary" disabled={files.data.pagination.page === files.data.pagination.pages} onClick={() => setPage((files.data?.pagination.page ?? page) + 1)}>Далее</button></nav>}
    {removing && <AnimatedOverlay variant="modal" dismissible={!deletion.isPending} onClose={() => setRemoving(null)}>{close => <ConfirmationDialog title="Удалить вложение?" resource={removing.fileName} description="Файл исчезнет из заявки и этой папки. В истории заявки останется отметка об удалении. Восстановить файл можно только повторной загрузкой." requiredText={removing.fileName} confirmLabel="Удалить вложение" pendingLabel="Удаляем…" busy={deletion.isPending} error={deletion.error?.message} onClose={close} onConfirm={() => deletion.mutate(removing)} />}</AnimatedOverlay>}
  </section>
}
