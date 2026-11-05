import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { securityActions, type SecurityHistory as History } from '../../../../app/security/events.ts'
import './security-history.scss'

export default function SecurityHistory({ organizationId }: { organizationId?: string }) {
  const { apiRequest } = useAuth(), [page, setPage] = useState(1)
  const history = useQuery({ queryKey: ['security-history', organizationId, page], queryFn: () => apiRequest<History>(`${organizationId ? `/organizations/${organizationId}` : '/profile'}/security-history?page=${page}`), staleTime: 30_000 })
  return <section className="settings-card security-history"><header><div><h2>Журнал безопасности</h2><p>{organizationId ? 'Входы в организационные данные и изменения доступа. Доступен владельцу.' : 'Входы, завершение сеансов и критические изменения вашего аккаунта.'} Срок хранения — 180 дней.</p></div><button className="app-secondary" disabled={history.isFetching} onClick={() => void history.refetch()}>Обновить</button></header>
    {history.isPending ? <p role="status">Загружаем историю…</p> : history.isError ? <p className="form-inline-error" role="alert">Не удалось загрузить журнал. Повторите запрос.</p> : <>
      {!history.data.entries.length ? <p>Событий пока нет.</p> : <ol className="security-history__entries">{history.data.entries.map(entry => <li key={entry.id}><div><strong>{securityActions[entry.action] ?? 'Событие безопасности'}</strong><span>{entry.actorLabel} · {entry.outcome === 'SUCCEEDED' ? 'Выполнено' : entry.outcome === 'DENIED' ? 'Доступ или подтверждение отклонены' : 'Ошибка выполнения'}{entry.count !== null ? ` · ${entry.count}` : ''}</span><details><summary>Номер события</summary><small>{entry.id}<br />Связанные действия: {entry.correlationId}</small></details></div><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</time></li>)}</ol>}
      {history.data.pagination.pages > 1 && <nav aria-label="Страницы журнала"><button className="app-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</button><span>{history.data.pagination.page} / {history.data.pagination.pages}</span><button className="app-secondary" disabled={page >= history.data.pagination.pages} onClick={() => setPage(page + 1)}>Далее</button></nav>}
      {!history.data.cleanupEnabled && <p className="profile-settings-note">Окончательная очистка выключена. Автоматическое удаление старых записей пока не выполняется.</p>}
    </>}
  </section>
}
