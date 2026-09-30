import { Link } from 'react-router-dom'
import { useDocuments } from '../../../app/documents/queries.ts'
import { stateLabels } from '../../../app/documents/types.ts'
import './documents.scss'
export default function RequiredDocuments({ organizationId }: { organizationId: string }) {
  const query = useDocuments(organizationId, { scope: 'required', pageSize: 5 })
  if (!query.isLoading && !query.isError && !query.data?.pagination.total) return null
  return <section className="document-required"><div><h2>Требуют ознакомления</h2><span>{query.data?.pagination.total ?? '…'}</span></div>{query.isLoading ? <p>Загружаем…</p> : query.isError ? <p role="alert">Не удалось загрузить документы. <button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></p> : query.data?.documents.map(item => <article key={item.id} className="document-row"><Link className="document-row__name" to={`/app/organizations/${organizationId}/documents?section=acknowledgements&document=${item.id}`}><strong>{item.displayName}</strong><small>{item.acknowledgement ? stateLabels[item.acknowledgement.state] : ''}</small></Link><Link className="app-secondary" to={`/app/organizations/${organizationId}/documents?section=acknowledgements&document=${item.id}`}>Открыть</Link></article>)}<Link className="app-back" to={`/app/organizations/${organizationId}/documents?section=acknowledgements`}>Все документы →</Link></section>
}
