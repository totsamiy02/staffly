import { useId, useState, type ReactNode } from 'react'

export default function TimesheetDisclosure({ title, count, children, compact = false }: {
  title: string
  count?: number
  children: ReactNode
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section className={`timesheet-disclosure${compact ? ' timesheet-disclosure--compact' : ''}`} data-open={open}>
      <h2>
        <button type="button" className="timesheet-disclosure__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
          <span>{title}</span>
          {count !== undefined && <small>{count}</small>}
          <svg className="timesheet-disclosure__chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
        </button>
      </h2>
      <div id={id} className="timesheet-disclosure__collapse" inert={!open} aria-hidden={!open}>
        <div>{children}</div>
      </div>
    </section>
  )
}

export function TimesheetFileIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" /><path d="M14 3v5h5M8 12h8M8 16h5" /></svg>
}
