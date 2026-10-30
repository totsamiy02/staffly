import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { liveQueryOptions } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { sizeLabel } from '../../../app/documents/types.ts'
import PageHeading from '../../../component/ui/page-heading/page-heading.tsx'

type RequestFile = { id: string; fileName: string; size: number; mimeType: string; createdAt: string; creatorName: string; typeName: string; locationName: string; requestHref: string; downloadPath: string }
type FilePage = { files: RequestFile[]; totalBytes: number; pagination: { page: number; pageSize: number; total: number; pages: number } }
function fileCount(value: number) { const form = new Intl.PluralRules('ru-RU').select(value); return `${value} ${form === 'one' ? 'файл' : form === 'few' ? 'файла' : 'файлов'}` }
function useRequestFiles(organizationId: string, page = 1, search = '') {
  const { apiRequest } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['document-request-files', organizationId, page, search], queryFn: () => apiRequest<FilePage>(`/organizations/${organizationId}/documents/request-attachments?${new URLSearchParams({ page: String(page), search })}`) })
}
export function RequestFilesFolder({ organizationId }: { organizationId: string }) {
  const query = useRequestFiles(organizationId), [, setParams] = useSearchParams()
  return <article className="document-folder-row document-system-folder"><button className="document-folder-open" onClick={() => setParams(previous => { const next = new URLSearchParams(); if (previous.get('location')) next.set('location', previous.get('location')!); next.set('system', 'request-attachments'); return next })}><span className="document-system-folder__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3V6Z" /><path d="m9 14 3 3 5-5" /></svg></span><span><strong>Вложения заявок</strong><small>{query.data ? `${fileCount(query.data.pagination.total)} · ${sizeLabel(query.data.totalBytes)}` : 'Автоматическая папка'} · доступ по исходным заявкам</small></span><span className="document-system-folder__label">Системная</span></button></article>
}
export default function RequestFiles({ organization }: { organization: OrganizationSummary }) {
  const [, setParams] = useSearchParams(), [search, setSearch] = useState(''), [debounced, setDebounced] = useState(''), [page, setPage] = useState(1)
  const files = useRequestFiles(organization.id, page, debounced), { downloadFile } = useAuth()
  const download = useMutation({ mutationFn: (file: RequestFile) => downloadFile(file.downloadPath, file.fileName) })
  useEffect(() => { const timer = window.setTimeout(() => { setDebounced(search.trim()); setPage(1) }, 250); return () => window.clearTimeout(timer) }, [search])
  return <section className="documents-page request-files-page"><PageHeading title="Вложения заявок" description="Файлы из доступных вам заявок. Папка обновляется автоматически, без копий и повторного расхода места." actions={<button className="app-secondary" onClick={() => setParams(previous => { const next = new URLSearchParams(); if (previous.get('location')) next.set('location', previous.get('location')!); return next })}>В библиотеку</button>} />
    <div className="request-files-toolbar"><input aria-label="Найти вложение заявки" type="search" placeholder="Название файла или тип заявки" value={search} onChange={e => setSearch(e.target.value)} /><span>{files.data ? `${fileCount(files.data.pagination.total)} · ${sizeLabel(files.data.totalBytes)}` : 'Загружаем…'}</span></div>
    {download.error && <p className="form-inline-error" role="alert">{download.error.message}</p>}
    <div className="request-files-list">{files.isLoading ? <div className="app-state" role="status">Загружаем вложения…</div> : files.isError ? <div className="app-state" role="alert"><p>{files.error.message}</p><button className="app-secondary" onClick={() => void files.refetch()}>Повторить</button></div> : files.data?.files.map(file => <article className="request-file-row" key={file.id}><span className="document-file-kind">{file.fileName.includes('.') ? file.fileName.split('.').pop()?.slice(0, 7).toUpperCase() : 'ФАЙЛ'}</span><div className="request-file-row__name"><strong>{file.fileName}</strong><small>{sizeLabel(file.size)} · {file.creatorName}</small><Link to={file.requestHref}>{file.typeName}</Link></div><span className="request-file-row__location">{file.locationName}</span><time dateTime={file.createdAt}>{new Date(file.createdAt).toLocaleDateString('ru-RU')}</time><button className="app-secondary" disabled={download.isPending} onClick={() => download.mutate(file)}>Скачать</button></article>)}{files.isSuccess && !files.data.files.length && <div className="app-state"><p>{debounced ? 'Вложения не найдены.' : 'В доступных вам заявках пока нет вложений.'}</p></div>}</div>
    {files.data && files.data.pagination.pages > 1 && <nav className="document-pagination" aria-label="Страницы вложений"><button className="app-secondary" disabled={files.data.pagination.page === 1} onClick={() => setPage((files.data?.pagination.page ?? page) - 1)}>Назад</button><span>{files.data.pagination.page} / {files.data.pagination.pages}</span><button className="app-secondary" disabled={files.data.pagination.page === files.data.pagination.pages} onClick={() => setPage((files.data?.pagination.page ?? page) + 1)}>Далее</button></nav>}
  </section>
}
