import { calendarKey as iso, parseCalendarDate as parse, calendarDate, browserToday } from './calendar-date.ts'
import { createPortal } from 'react-dom'
import { formatTimeEntry } from './time-format'
import { useEffect, useLayoutEffect, useId, useRef, useState, type InputHTMLAttributes, type CSSProperties, type ChangeEvent, type KeyboardEvent } from 'react'

type Props = InputHTMLAttributes<HTMLInputElement>
const firstOfMonth = (date: Date) => calendarDate(date.getUTCFullYear(), date.getUTCMonth(), 1)

export default function DatePicker({ value, onChange, min, max, disabled, readOnly, required, id, ...props }: Props) {
  const text = String(value ?? '')
  const [month, setMonth] = useState(firstOfMonth(parse(text || browserToday())))
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [focusedDay, setFocusedDay] = useState(text || browserToday())
  const pendingFocus = useRef<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const allowed = (day: string) => (!min || day >= String(min)) && (!max || day <= String(max))

  useEffect(() => {
    setLabel(host.current?.closest('label')?.querySelector(':scope > span')?.textContent ?? '')
    function outside(event: PointerEvent) { if (!host.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== panelId) setOpen(false) }
    document.addEventListener('staffly:popover-open', otherOpened)
    document.addEventListener('pointerdown', outside, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('staffly:popover-open', otherOpened) }
  }, [panelId])
  useEffect(() => { setInvalid(false) }, [value])
  useLayoutEffect(() => {
    if (!open || popupStyle.visibility !== 'visible' || !pendingFocus.current) return
    popup.current?.querySelector<HTMLButtonElement>(`[data-date="${pendingFocus.current}"]`)?.focus()
    pendingFocus.current = null
  }, [open, month, popupStyle.visibility])

  useLayoutEffect(() => {
    if (!open) return
    function position() {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const inset = 12, gap = 6, width = Math.min(280, window.innerWidth - inset * 2)
      const below = window.innerHeight - rect.bottom - inset - gap, above = rect.top - inset - gap
      const upward = below < (popup.current?.scrollHeight ?? 320) && above > below
      setPopupStyle({ position: 'fixed', width, maxWidth: width, minWidth: 0, maxHeight: Math.max(80, upward ? above : below), overflowY: 'auto', left: Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset)), ...(upward ? { bottom: window.innerHeight - rect.top + gap, top: 'auto' } : { top: Math.max(inset, rect.bottom + gap), bottom: 'auto' }), visibility: 'visible' })
    }
    position()
    const observer = new ResizeObserver(position)
    if (trigger.current) observer.observe(trigger.current)
    function scroll(event: Event) { if (!popup.current?.contains(event.target as Node)) position() }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', scroll, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', scroll, true) }
  }, [open, month, required, text])

  function openCalendar() {
    if (readOnly || disabled) return
    document.dispatchEvent(new CustomEvent('staffly:popover-open', { detail: panelId }))
    let day = text || browserToday()
    if (min && day < String(min)) day = String(min)
    if (max && day > String(max)) day = String(max)
    setFocusedDay(day)
    pendingFocus.current = day
    setMonth(firstOfMonth(parse(day)))
    setPopupStyle({ visibility: 'hidden' })
    setOpen(true)
  }
  function choose(day: string) {
    if (day && !allowed(day)) return
    setInvalid(false)
    onChange?.({ target: { value: day }, currentTarget: { value: day } } as ChangeEvent<HTMLInputElement>)
    setOpen(false)
    trigger.current?.focus()
  }
  function moveFocus(event: KeyboardEvent, day: string) {
    const date = parse(day)
    const weekday = (date.getUTCDay() + 6) % 7
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[event.key]
    if (delta === undefined && !['PageUp', 'PageDown'].includes(event.key)) return
    event.preventDefault()
    if (delta !== undefined) date.setUTCDate(date.getUTCDate() + delta)
    else {
      const originalDay = date.getUTCDate()
      date.setUTCDate(1)
      date.setUTCMonth(date.getUTCMonth() + (event.key === 'PageUp' ? -1 : 1))
      date.setUTCDate(Math.min(originalDay, calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getUTCDate()))
    }
    const next = iso(date)
    if (!allowed(next)) return
    setFocusedDay(next)
    if (date.getUTCMonth() !== month.getUTCMonth() || date.getUTCFullYear() !== month.getUTCFullYear()) {
      pendingFocus.current = next
      setMonth(firstOfMonth(date))
    } else popup.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus()
  }
  function moveMonth(delta: number) {
    const next = calendarDate(month.getUTCFullYear(), month.getUTCMonth() + delta, 1)
    setMonth(next)
    const day = min && iso(next) < String(min) ? String(min) : iso(next)
    setFocusedDay(day)
  }
  const offset = (month.getUTCDay() + 6) % 7
  const count = calendarDate(month.getUTCFullYear(), month.getUTCMonth() + 1, 0).getUTCDate()
  return <div className="staffly-date" ref={host} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Tab' && open && popup.current?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <input {...props} type="text" value={text} onChange={() => undefined} disabled={disabled} required={required && !readOnly} tabIndex={-1} aria-hidden="true" onFocus={() => trigger.current?.focus()} className="staffly-select__validation" onInvalid={event => { event.preventDefault(); setInvalid(true); openCalendar() }} />
    <button id={id} ref={trigger} type="button" className={`staffly-control${text ? '' : ' is-placeholder'}`} disabled={disabled} aria-label={props['aria-label'] ?? (label || 'Дата')} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} aria-required={required} aria-invalid={props['aria-invalid'] ?? invalid} aria-readonly={readOnly} onClick={event => { event.preventDefault(); event.stopPropagation(); if (open) setOpen(false); else openCalendar() }}>
      {text ? parse(text).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : 'Выберите дату'}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12v12H4zM7 3v4m6-4v4M4 9h12" /></svg>
    </button>
    {open && createPortal(<div ref={popup} style={popupStyle} id={panelId} role="dialog" aria-label="Выбор даты" className="staffly-calendar staffly-calendar--floating">
      <header><button type="button" aria-label="Предыдущий месяц" disabled={!!min && iso(calendarDate(month.getUTCFullYear(), month.getUTCMonth(), 0)) < String(min)} onClick={() => moveMonth(-1)}>‹</button><strong aria-live="polite">{month.toLocaleDateString('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' })}</strong><button type="button" aria-label="Следующий месяц" disabled={!!max && iso(calendarDate(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)) > String(max)} onClick={() => moveMonth(1)}>›</button></header>
      <div className="staffly-calendar__days">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day => <span key={day}>{day}</span>)}{Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}{Array.from({ length: count }, (_, index) => {
        const day = iso(calendarDate(month.getUTCFullYear(), month.getUTCMonth(), index + 1))
        return <button type="button" key={day} disabled={!allowed(day)} tabIndex={focusedDay === day ? 0 : -1} aria-label={parse(day).toLocaleDateString('ru-RU', { timeZone: 'UTC', dateStyle: 'full' })} aria-pressed={text === day} onFocus={() => setFocusedDay(day)} onClick={() => choose(day)} onKeyDown={event => moveFocus(event, day)} data-date={day}>{index + 1}</button>
      })}</div>
      {!required && text && <button type="button" className="staffly-calendar__clear" onClick={() => choose('')}>Очистить дату</button>}
    </div>, document.body)}
  </div>
}

export function TimeInput({ onChange, onBlur, value, ...props }: Props) {
  const [touched, setTouched] = useState(false)
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const text = String(value ?? '')
  const invalid = !!text && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(text)
  useEffect(() => { input.current?.setCustomValidity(invalid ? 'Введите время от 00:00 до 23:59.' : '') }, [text, invalid])
  function change(event: ChangeEvent<HTMLInputElement>, complete = false) {
    const next = formatTimeEntry(event.target.value, complete)
    event.target.value = next
    event.target.setCustomValidity(next && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(next) ? 'Введите время от 00:00 до 23:59.' : '')
    onChange?.(event)
  }
  return <span className="staffly-time"><input {...props} ref={input} type="text" value={value} onChange={event => change(event)} onBlur={event => { change(event, true); setTouched(true); onBlur?.(event) }} onInvalid={() => setTouched(true)} aria-invalid={props['aria-invalid'] ?? (touched && invalid)} aria-describedby={[props['aria-describedby'], touched && invalid ? hintId : ''].filter(Boolean).join(' ') || undefined} inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5} pattern="([01][0-9]|2[0-3]):[0-5][0-9]" title="Время от 00:00 до 23:59" />{touched && invalid && <small id={hintId} className="staffly-time__error">Введите время от 00:00 до 23:59</small>}</span>
}
