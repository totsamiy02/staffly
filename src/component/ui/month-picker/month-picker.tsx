import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import ModuleIcon from '../module-icon.tsx'
import { formatMonth, moveMonth } from '../../../app/schedule/date-utils.ts'
import './month-picker.scss'

const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']
const monthValue = (year: number, month: number) => `${year}-${String(month + 1).padStart(2, '0')}`
const monthLabel = (value: string) => formatMonth(value).replace(/\s*г\.$/, '')

/** Month selection with the same portal, popover coordination and neutral controls as DatePicker. */
export default function MonthPicker({ value, onChange, currentMonth, min = '2000-01', max = '2099-12', disabled = false, label = 'Период' }: {
  value: string; onChange: (value: string) => void; currentMonth: string; min?: string; max?: string; disabled?: boolean; label?: string
}) {
  const panelId = useId(), yearId = useId()
  const host = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false), [year, setYear] = useState(Number(value.slice(0, 4))), [draft, setDraft] = useState(value.slice(0, 4)), [invalidYear, setInvalidYear] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const minYear = Number(min.slice(0, 4)), maxYear = Number(max.slice(0, 4))
  const validYear = draft.length === 4 && Number(draft) >= minYear && Number(draft) <= maxYear
  const allowed = (next: string) => next >= min && next <= max
  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (next: string) => { if (allowed(next)) { onChange(next); close() } }
  const changeYear = (next: number) => { setYear(next); setDraft(String(next)); setInvalidYear(false) }
  function show() {
    document.dispatchEvent(new CustomEvent('staffly:popover-open', { detail: panelId }))
    changeYear(Number(value.slice(0, 4)))
    setStyle({ visibility: 'hidden' })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== panelId) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('staffly:popover-open', otherOpened)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('staffly:popover-open', otherOpened) }
  }, [open, panelId])
  useLayoutEffect(() => {
    if (!open) return
    function position() {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const inset = 12, gap = 6, width = Math.min(300, window.innerWidth - inset * 2)
      const below = window.innerHeight - rect.bottom - inset - gap, above = rect.top - inset - gap
      const upward = below < (popup.current?.scrollHeight ?? 310) && above > below
      setStyle({ position: 'fixed', width, maxHeight: Math.max(80, upward ? above : below), left: Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset)), ...(upward ? { bottom: window.innerHeight - rect.top + gap, top: 'auto' } : { top: rect.bottom + gap, bottom: 'auto' }), visibility: 'visible' })
    }
    position()
    const observer = new ResizeObserver(position)
    if (trigger.current) observer.observe(trigger.current)
    function scroll(event: Event) { if (!popup.current?.contains(event.target as Node)) position() }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', scroll, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', scroll, true) }
  }, [open, invalidYear])
  useLayoutEffect(() => {
    if (open && style.visibility === 'visible') popup.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  }, [open, style.visibility])
  function popupKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key !== 'Tab') return
    // The portal is outside DocumentDialog's DOM. Keep its keyboard focus in this small dialog.
    event.stopPropagation()
    const items = Array.from(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])
    if (event.shiftKey && event.target === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
    else if (!event.shiftKey && event.target === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
  }
  function gridKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - 3, ArrowDown: index + 3, Home: 0, End: 11 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    if (next >= 0 && next < 12) popup.current?.querySelector<HTMLButtonElement>(`[data-month="${next}"]:not(:disabled)`)?.focus()
  }
  const previous = moveMonth(value, -1), next = moveMonth(value, 1)
  return <div ref={host} className="staffly-month" onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button type="button" className="staffly-month__arrow" aria-label="Предыдущий месяц" disabled={disabled || !allowed(previous)} onClick={() => { setOpen(false); onChange(previous) }}>‹</button>
    <button ref={trigger} type="button" className="staffly-month__trigger" aria-label={`${label}: ${monthLabel(value)}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => open ? close() : show()}><ModuleIcon section="schedule" /><span>{monthLabel(value)}</span></button>
    <button type="button" className="staffly-month__arrow" aria-label="Следующий месяц" disabled={disabled || !allowed(next)} onClick={() => { setOpen(false); onChange(next) }}>›</button>
    {open && createPortal(<div ref={popup} id={panelId} role="dialog" aria-label="Выбор месяца и года" className="staffly-month-popup" style={style} onKeyDown={popupKeys} onBlur={event => { if (event.relatedTarget && !popup.current?.contains(event.relatedTarget) && !host.current?.contains(event.relatedTarget)) setOpen(false) }}>
      <div className="staffly-month-popup__year">
        <button type="button" aria-label="Предыдущий год" disabled={year <= minYear} onClick={() => changeYear(year - 1)}>‹</button>
        <input aria-label="Год" aria-invalid={invalidYear} aria-describedby={invalidYear ? yearId : undefined} type="text" inputMode="numeric" maxLength={4} value={draft} onFocus={event => event.currentTarget.select()} onChange={event => {
          const text = event.target.value.replace(/\D/g, '')
          setDraft(text); setInvalidYear(false)
          if (text.length === 4 && Number(text) >= minYear && Number(text) <= maxYear) setYear(Number(text))
        }} onBlur={() => { setInvalidYear(draft.length !== 4 || Number(draft) < minYear || Number(draft) > maxYear) }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); const valid = draft.length === 4 && Number(draft) >= minYear && Number(draft) <= maxYear; setInvalidYear(!valid); if (valid) popup.current?.querySelector<HTMLButtonElement>(`[data-month="${Number(value.slice(5)) - 1}"]:not(:disabled)`)?.focus() }
        }} />
        <button type="button" aria-label="Следующий год" disabled={year >= maxYear} onClick={() => changeYear(year + 1)}>›</button>
      </div>
      {invalidYear && <p id={yearId} className="staffly-month-popup__error" role="alert">Введите год от {minYear} до {maxYear}.</p>}
      <div className="staffly-month-popup__grid" role="group" aria-label={`Месяцы ${year} года`}>{months.map((name, index) => {
        const option = monthValue(year, index)
        return <button key={name} type="button" data-month={index} aria-label={monthLabel(option)} aria-pressed={option === value} disabled={!validYear || !allowed(option)} onClick={() => choose(option)} onKeyDown={event => gridKeys(event, index)}>{name}</button>
      })}</div>
      <button type="button" className="staffly-month-popup__today" disabled={!allowed(currentMonth)} onClick={() => choose(currentMonth)}>Текущий месяц</button>
    </div>, document.body)}
  </div>
}
