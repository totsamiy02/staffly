import { liveQueryOptions } from '../../../app/live-query.ts'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { DocumentItem } from '../../../app/documents/types.ts'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'
import DocumentDrawer from './document-drawer.tsx'
import DocumentRow from './document-row.tsx'
import './documents.scss'
export default function PersonalDocuments({ organizationId }: { organizationId?: string }) {
  const { locationId, apiRequest } = useAuth(), [page, setPage] = useState(1), [selected, setSelected] = useState<DocumentItem | null>(null)
  const query = useQuery({ ...liveQueryOptions, queryKey: ['personal-documents', organizationId, page, locationId], queryFn: () => apiRequest<{ documents: DocumentItem[]; pagination: { pages: number; total: number } }>(`/profile/documents?page=${page}${organizationId ? `&organizationId=${organizationId}` : ""}`) })
  const groups = new Map<string, DocumentItem[]>(); for (const item of query.data?.documents ?? []) { const group = groups.get(item.organizationId) ?? []; group.push(item); groups.set(item.organizationId, group) }
  return <section className="personal-documents"><h2>Мои документы</h2><p>{organizationId ? 'Личные документы этой организации.' : 'Личные документы по организациям, в которых вы состоите.'}</p>{query.isLoading ? <p className="app-state">Загружаем документы…</p> : query.isError ? <div className="app-state" role="alert"><p>{query.error.message}</p><button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : groups.size ? Array.from(groups.entries()).map(([id, items]) => <section key={id}><h3>{items[0].organization?.name}</h3>{items.map(item => <DocumentRow item={item} key={item.id} onOpen={() => setSelected(item)} />)}</section>) : <p className="app-state">Личных документов пока нет.</p>}{query.data && query.data.pagination.pages > 1 && <div className="document-pagination"><button className="app-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Назад</button><span>{page}/{query.data.pagination.pages}</span><button className="app-secondary" disabled={page === query.data.pagination.pages} onClick={() => setPage(page + 1)}>Далее</button></div>}{selected && <AnimatedOverlay variant="modal" className="document-viewer-overlay" onClose={() => setSelected(null)}>{close => <DocumentDrawer organizationId={selected.organizationId} documentId={selected.id} pointId={selected.locationId} manager={false} onClose={close} />}</AnimatedOverlay>}</section>
}
