import { createPortal } from 'react-dom'
import { Children, isValidElement, useEffect, useLayoutEffect, useId, useRef, useState, useCallback, type SelectHTMLAttributes, type ReactNode, type ChangeEvent, type KeyboardEvent, type CSSProperties } from 'react'

type Props = SelectHTMLAttributes<HTMLSelectElement> & { searchable?: boolean }
type Option = { value: string; label: ReactNode; disabled: boolean; search: string }

export default function Select({ children, value, onChange, disabled, required, id, searchable = false, ...props }: Props) {
  const listId = useId()
  const host = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [search, setSearch] = useState('')
  const [label, setLabel] = useState('')
  const [invalid, setInvalid] = useState(false)
  const openRef = useRef(false)
  const pointerClick = useRef(false)
  const options: Option[] = []
  function collect(nodes: ReactNode) {
    Children.forEach(nodes, child => {
      if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; 'data-search'?: string }>(child)) return
      if (child.type === 'option') options.push({ value: String(child.props.value ?? ''), label: child.props.children, disabled: !!child.props.disabled, search: child.props['data-search'] ?? String(child.props.children) })
      else collect(child.props.children)
    })
  }
  collect(children)
  const matches = options.map((option, index) => ({ ...option, index })).filter(option => search.trim().toLocaleLowerCase().split(/\s+/).every(term => option.search.toLocaleLowerCase().includes(term)))
  const available = matches.filter(option => !option.disabled)
  const selected = options.findIndex(option => option.value === String(value ?? ''))
  const setOpenState = useCallback((next: boolean) => {
    if (next) document.dispatchEvent(new CustomEvent('staffly:popover-open', { detail: listId }))
    openRef.current = next
    setOpen(next)
    if (!next) setSearch('')
  }, [listId])
  useEffect(() => {
    setLabel(host.current?.closest('label')?.querySelector(':scope > span')?.textContent ?? '')
    function outside(event: PointerEvent) { if (!host.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpenState(false) }
    const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== listId) setOpenState(false) }
    document.addEventListener('staffly:popover-open', otherOpened)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('staffly:popover-open', otherOpened) }
  }, [listId, setOpenState])
  useEffect(() => { setInvalid(false) }, [value])
  useLayoutEffect(() => {
    if (!open) return
    function position() {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const gap = 6, inset = 12, below = window.innerHeight - rect.bottom - inset - gap, above = rect.top - inset - gap
      const upward = below < 240 && above > below
      const height = Math.max(80, Math.min(320, upward ? above : below))
      const width = Math.min(rect.width, window.innerWidth - inset * 2)
      setPopupStyle({ position: 'fixed', width, maxHeight: height, left: Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset)), ...(upward ? { bottom: window.innerHeight - rect.top + gap, top: 'auto' } : { top: rect.bottom + gap, bottom: 'auto' }), visibility: 'visible' })
    }
    position()
    window.addEventListener('resize', position)
    function scroll(event: Event) { if (!popup.current?.contains(event.target as Node)) position() }
    window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  useLayoutEffect(() => {
    const list = popup.current, option = list?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!open || !list || !option) return
    const searchHeight = list.querySelector('input')?.getBoundingClientRect().height ?? 0
    const top = option.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    if (top < list.scrollTop + searchHeight) list.scrollTop = top - searchHeight
    else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight
  }, [active, open, popupStyle])

  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } } as ChangeEvent<HTMLSelectElement>)
    setOpenState(false)
    setInvalid(false)
    trigger.current?.focus()
  }
  function navigate(event: KeyboardEvent, fromSearch = false) {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpenState(false); trigger.current?.focus(); return }
    if (event.key === 'Tab' && open) { setOpenState(false); if (fromSearch) { event.preventDefault(); event.stopPropagation(); trigger.current?.focus() } return }
    if (fromSearch && event.key === ' ') return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      if (!open) { setOpenState(true); setActive(Math.max(0, selected)); return }
      if (event.key === 'Enter' || event.key === ' ') { if (available.some(option => option.index === active)) choose(active); return }
      if (!available.length) return
      const position = available.findIndex(option => option.index === active)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (position + (event.key === 'ArrowUp' ? -1 : 1) + available.length) % available.length
      setActive(available[next].index)
    } else if (!fromSearch && event.key.length === 1) {
      const index = options.findIndex(option => !option.disabled && option.search.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
      if (index >= 0) { setOpenState(true); setActive(index) }
    }
  }
  const accessibleLabel = props['aria-label'] ?? (label || undefined)
  return <div className="staffly-select" ref={host} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) setOpenState(false) }}>
    <select {...props} value={value} disabled={disabled} required={required} onChange={onChange} tabIndex={-1} aria-hidden="true" onFocus={() => trigger.current?.focus()} className="staffly-select__validation" onInvalid={event => { event.preventDefault(); setInvalid(true); trigger.current?.focus(); setOpenState(true) }}>
      {options.map((option, index) => <option key={`${option.value}-${index}`} value={option.value} disabled={option.disabled}>{option.search}</option>)}
    </select>
    <button id={id} ref={trigger} type="button" role="combobox" aria-label={accessibleLabel} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']} aria-expanded={open} aria-controls={listId} aria-owns={open ? listId : undefined} aria-haspopup="listbox" aria-required={required} aria-invalid={props['aria-invalid'] ?? invalid} aria-activedescendant={open && available.some(option => option.index === active) ? `${listId}-${active}` : undefined} disabled={disabled} className="staffly-control" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); pointerClick.current = true; setActive(Math.max(0, selected)); setOpenState(!openRef.current) }} onClick={() => { if (pointerClick.current) { pointerClick.current = false; return } setActive(Math.max(0, selected)); setOpenState(!openRef.current) }} onKeyDown={event => navigate(event)}>
      <span>{options[selected]?.label ?? 'Выберите значение'}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg>
    </button>
    {open && createPortal(<div ref={popup} style={popupStyle} className="staffly-select__options staffly-select__options--floating">
      {searchable && <input type="search" role="combobox" aria-label="Поиск сотрудника" aria-expanded="true" aria-controls={listId} aria-activedescendant={available.some(option => option.index === active) ? `${listId}-${active}` : undefined} placeholder="ФИО или почта" value={search} onChange={event => { setSearch(event.target.value); const terms = event.target.value.trim().toLocaleLowerCase().split(/\s+/); setActive(options.findIndex(option => !option.disabled && terms.every(term => option.search.toLocaleLowerCase().includes(term)))) }} onKeyDown={event => navigate(event, true)} autoFocus />}
      <div id={listId} role="listbox" aria-label={accessibleLabel}>
        {!matches.length && <p className="staffly-select__empty">Ничего не найдено</p>}
        {matches.map(({ index, ...option }) => <div role="option" id={`${listId}-${index}`} data-index={index} key={`${option.value}-${index}`} aria-selected={index === selected} aria-disabled={option.disabled} className={index === active ? 'is-active' : ''} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>{option.label}{index === selected && <span aria-hidden="true">✓</span>}</div>)}
      </div>
    </div>, document.body)}
  </div>
}
