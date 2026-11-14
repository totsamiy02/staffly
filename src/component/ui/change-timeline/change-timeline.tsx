import './change-timeline.scss'

type ChangeEntry = {
  id: string
  actorName: string
  createdAt: string
  changes: Array<{ field: string; before: string | null; after: string | null }>
}

type ChangeTimelineProps = {
  items: ChangeEntry[]
  labels: Record<string, string>
  timezone?: string
}

export default function ChangeTimeline({ items, labels, timezone }: ChangeTimelineProps) {
  return (
    <ol className="change-timeline">
      {items.map(item => (
        <li key={item.id}>
          <span className="change-timeline__avatar" aria-hidden="true">
            {item.actorName.slice(0, 1).toUpperCase()}
          </span>
          <article>
            <header>
              <strong>{item.actorName}</strong>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString('ru-RU', {
                  ...(timezone ? { timeZone: timezone } : {}),
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </header>
            <dl>
              {item.changes.map(change => (
                <div key={change.field}>
                  <dt>{labels[change.field] ?? change.field}</dt>
                  <dd>
                    <span className="change-timeline__before">{change.before || 'Не указано'}</span>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M2 8h11m-4-4 4 4-4 4" />
                    </svg>
                    <span className="change-timeline__after">{change.after || 'Не указано'}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        </li>
      ))}
    </ol>
  )
}
