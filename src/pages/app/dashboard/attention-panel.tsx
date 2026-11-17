import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../../app/auth/auth-context.tsx';
import { liveQueryOptions } from '../../../app/live-query.ts';
import type { AttentionFilter, AttentionItem, AttentionPage, AttentionScope } from '../../../shared/attention.ts';
import ReminderSettings from './reminder-settings.tsx';
import './attention-panel.scss';

export function AttentionIcon({ kind }: { kind: AttentionItem['kind'] | 'bell' | 'clock' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'DEPARTURE' ? <path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9" /> : kind === 'bell' ? <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></> : kind === 'clock' || kind === 'AVAILABILITY' ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : kind === 'DOCUMENT' ? <><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" /></> : kind === 'TASK' ? <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 3 3 5-6" /></> : <><path d="M5 4h14v13H9l-4 4zM9 8h6m-6 4h4" /></>}</svg>;
}
function deadline(item: AttentionItem) {
  if (!item.dueAt) return 'Без срока';
  const date = new Date(item.deadlineDay ? `${item.deadlineDay}T12:00:00Z` : item.dueAt);
  return `До ${date.toLocaleDateString('ru-RU', { timeZone: item.deadlineDay ? 'UTC' : item.timezone, day: 'numeric', month: 'short', year: 'numeric', ...(!item.deadlineDay ? { hour: '2-digit', minute: '2-digit' } : {}) })}`;
}
export default function AttentionPanel({ organizationId, pointId = 'all' }: { organizationId: string; pointId?: string }) {
  return <AttentionQueue key={`${organizationId}:${pointId}`} organizationId={organizationId} pointId={pointId} />;
}
function AttentionQueue({ organizationId, pointId }: { organizationId: string; pointId: string }) {
  const { apiRequest } = useAuth();
  const [scope, setScope] = useState<AttentionScope>('mine'), [filter, setFilter] = useState<AttentionFilter>('all'), [page, setPage] = useState(1), [settings, setSettings] = useState(false);
  const query = useQuery({ ...liveQueryOptions, queryKey: ['attention', organizationId, pointId, scope, filter, page],
    queryFn: () => apiRequest<AttentionPage>(`/organizations/${organizationId}/attention?${new URLSearchParams({ pointId, scope, filter, page: String(page), pageSize: '5' })}`) });
  const data = query.data;
  useEffect(() => { if (data && page > data.pagination.pages) setPage(data.pagination.pages); }, [data, page]);
  const counts = data?.counts;
  return <section className="attention-panel" aria-label="Требует внимания">
    <header className="attention-panel__heading"><div><h2>Требует внимания{counts && <span>{counts.total}</span>}</h2><p>Заявки, задачи и ознакомления — в одном месте</p></div><button className="attention-panel__settings" type="button" aria-label="Настроить напоминания" title="Настроить напоминания" onClick={() => setSettings(true)}><AttentionIcon kind="bell" /></button></header>
    <div className="attention-panel__tabs" role="group" aria-label="Очередь действий">{([{ key: 'mine', label: 'Мои действия' }, { key: 'control', label: 'Под контролем' }] as const).map(tab => <button key={tab.key} aria-pressed={scope === tab.key} onClick={() => { setScope(tab.key); setFilter('all'); setPage(1); }}>{tab.label}{counts && <span>{counts[tab.key]}</span>}</button>)}</div>
    <div className="attention-panel__filters" role="group" aria-label="Фильтр очереди">{([{ key: 'all', label: 'Все' }, { key: 'overdue', label: 'Просрочено' }, ...(scope === 'control' ? [{ key: 'blocked' as const, label: 'Без ответственного' }] : [])] as const).map(item => <button key={item.key} aria-pressed={filter === item.key} onClick={() => { setFilter(item.key); setPage(1); }}>{item.label}{item.key !== 'all' && counts && <span>{counts[item.key]}</span>}</button>)}</div>
    <div className="attention-panel__list" aria-live="polite" aria-busy={query.isFetching}>
      {query.isPending ? <p className="attention-panel__empty" role="status">Загружаем действия…</p> : query.isError ? <div className="attention-panel__empty" role="alert">Не удалось загрузить очередь.<button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : !data?.items.length ? <p className="attention-panel__empty">{filter === 'overdue' ? 'Просроченных действий нет.' : filter === 'blocked' ? 'Все действия имеют ответственного.' : scope === 'mine' ? 'Всё готово. Действий для вас пока нет.' : 'Нет действий, требующих контроля.'}</p> : data.items.map(item => <article className="attention-row" key={item.id}>
        <span className="attention-row__icon"><AttentionIcon kind={item.kind} /></span><div className="attention-row__content"><h3>{item.title}</h3><p>{item.subtitle} · {item.locationName}</p><div className="attention-row__details"><span className={item.overdue || item.blocked ? 'attention-row__urgent' : ''}><AttentionIcon kind="clock" />{item.overdue ? `Просрочено · ${item.reason}` : item.reason}</span><time dateTime={item.deadlineDay ?? item.dueAt ?? undefined}>{deadline(item)}</time></div></div><Link className="attention-row__action" to={item.href}>{item.action}<span aria-hidden="true">↗</span></Link>
      </article>)}
    </div>
    {data && data.pagination.pages > 1 && <nav className="attention-panel__pagination" aria-label="Страницы очереди"><span>{data.pagination.total} действий · {page} / {data.pagination.pages}</span><button disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}>Назад</button><button disabled={page >= data.pagination.pages || query.isFetching} onClick={() => setPage(page + 1)}>Далее</button></nav>}
    {settings && <ReminderSettings onClose={() => setSettings(false)} />}
  </section>;
}
