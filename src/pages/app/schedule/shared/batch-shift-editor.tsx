import { useEffect, useId, useState } from 'react'
import DatePicker, { TimeInput } from '../../../../component/ui/date-picker/date-picker.tsx'
import PlanningMonthCalendar from '../../shared/planning-month-calendar.tsx'
import { addDays, displayDate, moveMonth } from '../../../../app/schedule/date-utils.ts'
import { MAX_BATCH_DATES, selectBatchDates, type BatchShiftOverrides, type BatchShiftTime } from '../../../../app/schedule/batch-shifts.ts'

type Props = {
  month: string
  onMonth: (month: string) => void
  dates: string[]
  onDates: (dates: string[]) => void
  common: BatchShiftTime
  overrides: BatchShiftOverrides
  onOverride: (day: string, value: BatchShiftTime | null) => void
  availability?: Record<string, string>
  invalidDate?: string
}

const modes = [['manual', 'Вручную'], ['range', 'Диапазон'], ['weekdays', 'Дни недели']] as const
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
const weekdayDate = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' })

export default function BatchShiftEditor({ month, onMonth, dates, onDates, common, overrides, onOverride, invalidDate, availability }: Props) {
  const id = useId()
  const [mode, setMode] = useState<typeof modes[number][0]>('manual')
  const [from, setFrom] = useState(dates[0] ?? `${month}-01`)
  const [to, setTo] = useState(dates.at(-1) && dates.length > 1 ? dates.at(-1)! : addDays(`${moveMonth(month, 1)}-01`, -1))
  const [days, setDays] = useState([0, 1, 2, 3, 4])
  const [selectionError, setSelectionError] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const changed = dates.filter(day => overrides[day]).length

  useEffect(() => {
    if (!invalidDate) return
    setExpanded(invalidDate)
    requestAnimationFrame(() => document.getElementById(`${id}-${invalidDate}`)?.scrollIntoView({ block: 'nearest' }))
  }, [id, invalidDate])

  function replaceDates(next: string[]) {
    setSelectionError('')
    if (expanded && !next.includes(expanded)) setExpanded(undefined)
    onDates(next)
  }

  function toggleDate(day: string) {
    if (!dates.includes(day) && dates.length >= MAX_BATCH_DATES) {
      setSelectionError(`За один раз можно выбрать не больше ${MAX_BATCH_DATES} дат.`)
      return
    }
    replaceDates(dates.includes(day) ? dates.filter(item => item !== day) : [...dates, day].sort())
  }

  function selectPeriod() {
    try {
      const next = selectBatchDates(from, to, mode === 'weekdays' ? days : undefined)
      replaceDates(next)
      onMonth(from.slice(0, 7))
    } catch (failure) {
      setSelectionError(failure instanceof Error ? failure.message : 'Проверьте выбранный период.')
    }
  }

  function selectMode(value: typeof modes[number][0]) {
    setMode(value)
    setSelectionError('')
  }

  function toggleWeekday(index: number) {
    setDays(current => current.includes(index) ? current.filter(day => day !== index) : [...current, index])
    setSelectionError('')
  }

  return <div className="batch-editor">
    <section className="batch-editor__dates" aria-label="Выбор дат смен">
      <h3>Даты смен</h3>
      <div className="batch-editor__modes" role="group" aria-label="Способ выбора дат">
        {modes.map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => selectMode(value)}>{label}</button>)}
      </div>
      {mode !== 'manual' && <div className="batch-editor__period">
        <div className="planning-time">
          <label>
            <span>С</span>
            <DatePicker value={from} onChange={event => {
              setFrom(event.target.value)
              setSelectionError('')
            }} />
          </label>
          <label>
            <span>По</span>
            <DatePicker value={to} onChange={event => {
              setTo(event.target.value)
              setSelectionError('')
            }} />
          </label>
        </div>
        {mode === 'weekdays' && <div className="batch-editor__weekdays" role="group" aria-label="Дни недели смен">
          {weekdays.map((label, index) => <button key={label} type="button" aria-pressed={days.includes(index)} onClick={() => toggleWeekday(index)}>{label}</button>)}
        </div>}
        <button type="button" className="batch-editor__button" onClick={selectPeriod}>{mode === 'weekdays' ? 'Выбрать дни недели' : 'Выбрать диапазон'}</button>
        <small>Заменяет текущий выбор. Отдельные даты можно изменить в календаре.</small>
      </div>}
      {selectionError && <p className="form-inline-error" role="alert">{selectionError}</p>}
      <PlanningMonthCalendar month={month} onMonth={onMonth} selected={dates} label="Даты новых смен" onDay={toggleDate} />
      <div className="batch-editor__selection" aria-live="polite">
        <span>Выбрано дат: <strong>{dates.length}</strong></span>
        <button type="button" className="batch-editor__button" disabled={!dates.length} onClick={() => replaceDates([])}>Очистить выбор</button>
      </div>
    </section>
    <section className="batch-editor__shifts" aria-label="Выбранные смены">
      <header><h3>Смены · {dates.length}</h3><p>{changed ? `По общему времени: ${dates.length - changed} · Индивидуально: ${changed}` : 'Общее время для всех дат'}</p></header>
      {!dates.length && <p className="batch-editor__empty">Выберите даты в календаре или задайте период.</p>}
      <div className="batch-editor__list">
        {dates.map(day => {
          const date = new Date(`${day}T00:00:00Z`)
          const times = overrides[day] ?? common
          const open = expanded === day
          const change = (value: Partial<BatchShiftTime>) => onOverride(day, { ...times, ...value })
          return <article key={day} id={`${id}-${day}`} className={`batch-shift${open ? ' is-expanded' : ''}${invalidDate === day ? ' has-error' : ''}${availability?.[day] ? ' has-availability-warning' : ''}`} aria-label={displayDate(day)}>
            <div className="batch-shift__summary">
              <div className="batch-shift__date">
                <strong>{shortDate.format(date)}</strong><span>{weekdayDate.format(date)}</span>
              </div>
              <div className="batch-shift__time">
                <span>{times.startTime || '—'}–{times.endTime || '—'}{times.overnight && <small> +1 день</small>}</span>
                {overrides[day] && <small className="batch-shift__badge">Изменено</small>}
              </div>
              <button type="button" className="batch-editor__button"
                aria-label={`${open ? 'Свернуть' : 'Изменить'} смену ${displayDate(day)}`}
                aria-expanded={open} aria-controls={`${id}-${day}-fields`}
                onClick={() => setExpanded(open ? undefined : day)}>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{open ? <path d="m5 12 5-5 5 5" /> : <><path d="m12 4 4 4M4 12l9-9a2 2 0 0 1 3 3l-9 9-4 1z" /></>}</svg>
                <span>{open ? 'Свернуть' : 'Изменить'}</span>
              </button>
            </div>
            {availability?.[day] && <div className="batch-availability-note">{availability[day]}</div>}
            {open && <div id={`${id}-${day}-fields`} className="batch-shift__fields">
              <div className="planning-time">
                <label><span>Начало</span><TimeInput value={times.startTime} required onChange={event => change({ startTime: event.target.value })} /></label>
                <label><span>Окончание</span><TimeInput value={times.endTime} required onChange={event => change({ endTime: event.target.value })} /></label>
              </div>
              <label className="planning-checkbox">
                <input type="checkbox" checked={times.overnight} onChange={event => change({ overnight: event.target.checked })} />
                <span>На следующий день</span>
              </label>
              {overrides[day] && <button type="button" className="batch-editor__button" onClick={() => onOverride(day, null)}>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 4-4 4 4 4M3 8h9a4 4 0 0 1 0 8H9" /></svg>
                Вернуть общее время
              </button>}
            </div>}
          </article>
        })}
      </div>
    </section>
  </div>
}
