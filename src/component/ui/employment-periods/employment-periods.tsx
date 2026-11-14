import { useId, useState } from 'react'
import './employment-periods.scss'

type EmploymentPeriod = {
  id?: string
  startedAt: Date | string | null
  endedAt: Date | string | null
  incomplete: boolean
}

type EmploymentPeriodsProps = {
  periods: EmploymentPeriod[]
  timezone?: string
}

export default function EmploymentPeriods({ periods, timezone = 'Europe/Moscow' }: EmploymentPeriodsProps) {
  const [open, setOpen] = useState(false)
  const id = useId()

  function formatDate(value: Date | string | null) {
    return value ? new Date(value).toLocaleDateString('ru-RU', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }) : 'Начало не зафиксировано'
  }

  if (!periods.length) return null
  const orderedPeriods = [...periods].sort((first, second) => {
    if (!first.endedAt && second.endedAt) return -1
    if (first.endedAt && !second.endedAt) return 1
    const firstDate = first.startedAt ?? first.endedAt
    const secondDate = second.startedAt ?? second.endedAt
    return (secondDate ? +new Date(secondDate) : 0) - (firstDate ? +new Date(firstDate) : 0)
  })

  return (
    <section className="employment-periods">
      <button type="button" className="employment-periods__toggle" aria-expanded={open}
        aria-controls={id} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2" />
        </svg>
        <span>Периоды работы</span>
        <small>{periods.length}</small>
        <svg className="employment-periods__chevron" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <div id={id} hidden={!open}>
        <ol className="employment-periods__list">
          {orderedPeriods.map((period, index) => (
            <li key={period.id ?? index}>
              <span className={'employment-periods__dot' + (period.endedAt ? '' : ' is-current')} aria-hidden="true" />
              <div className="employment-periods__entry">
                <span className="employment-periods__status">
                  {period.endedAt ? 'Завершённый период' : 'Текущий период'}
                </span>
                <strong>{formatDate(period.startedAt)}</strong>
                <span>{period.endedAt ? 'По ' + formatDate(period.endedAt) : 'По настоящее время'}</span>
                {period.incomplete && (
                  <p>История до начала учёта неполная. Прежние приёмы и исключения могли не сохраниться.</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
