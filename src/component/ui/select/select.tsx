import { Children, isValidElement, useEffect, useId, useRef, useState, type SelectHTMLAttributes, type ReactNode, type ChangeEvent, type KeyboardEvent } from 'react'

type Props = SelectHTMLAttributes<HTMLSelectElement> & { searchable?: boolean }
type Option = { value: string; label: ReactNode; disabled: boolean; search: string }

export default function Select({ children, value, onChange, disabled, required, id, searchable = false, ...props }: Props) {
  const listId = useId()
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [search, setSearch] = useState('')
  const [label, setLabel] = useState('')
  const [invalid, setInvalid] = useState(false)
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
  useEffect(() => {
    setLabel(host.current?.closest('label')?.querySelector(':scope > span')?.textContent ?? '')
    function outside(event: PointerEvent) { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useEffect(() => { setInvalid(false) }, [value])
  useEffect(() => { if (open) host.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, open])
  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } } as ChangeEvent<HTMLSelectElement>)
    setOpen(false)
    setInvalid(false)
    trigger.current?.focus()
  }
  function navigate(event: KeyboardEvent, fromSearch = false) {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
    if (event.key === 'Tab') return
    if (fromSearch && event.key === ' ') return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      if (!open) { setSearch(''); setOpen(true); setActive(Math.max(0, selected)); return }
      if (event.key === 'Enter' || event.key === ' ') { if (available.some(option => option.index === active)) choose(active); return }
      if (!available.length) return
      const position = available.findIndex(option => option.index === active)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (position + (event.key === 'ArrowUp' ? -1 : 1) + available.length) % available.length
      setActive(available[next].index)
    } else if (!fromSearch && event.key.length === 1) {
      const index = options.findIndex(option => !option.disabled && option.search.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
      if (index >= 0) { setOpen(true); setActive(index) }
    }
  }
  const accessibleLabel = props['aria-label'] ?? (label || undefined)
  return <div className="staffly-select" ref={host} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <select {...props} value={value} disabled={disabled} required={required} onChange={onChange} tabIndex={-1} aria-hidden="true" onFocus={() => trigger.current?.focus()} className="staffly-select__validation" onInvalid={event => { event.preventDefault(); setInvalid(true); trigger.current?.focus(); setOpen(true) }}>
      {options.map((option, index) => <option key={`${option.value}-${index}`} value={option.value} disabled={option.disabled}>{option.search}</option>)}
    </select>
    <button id={id} ref={trigger} type="button" role="combobox" aria-label={accessibleLabel} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox" aria-required={required} aria-invalid={props['aria-invalid'] ?? invalid} aria-activedescendant={open && available.some(option => option.index === active) ? `${listId}-${active}` : undefined} disabled={disabled} className="staffly-control" onClick={() => { setActive(Math.max(0, selected)); setSearch(''); setOpen(!open) }} onKeyDown={event => navigate(event)}>
      <span>{options[selected]?.label ?? 'Выберите значение'}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg>
    </button>
    {open && <div className="staffly-select__options">
      {searchable && <input type="search" role="combobox" aria-label="Поиск сотрудника" aria-expanded="true" aria-controls={listId} aria-activedescendant={available.some(option => option.index === active) ? `${listId}-${active}` : undefined} placeholder="ФИО или почта" value={search} onChange={event => { setSearch(event.target.value); const terms = event.target.value.trim().toLocaleLowerCase().split(/\s+/); setActive(options.findIndex(option => !option.disabled && terms.every(term => option.search.toLocaleLowerCase().includes(term)))) }} onKeyDown={event => navigate(event, true)} autoFocus />}
      <div id={listId} role="listbox" aria-label={accessibleLabel}>
        {!matches.length && <p className="staffly-select__empty">Ничего не найдено</p>}
        {matches.map(({ index, ...option }) => <div role="option" id={`${listId}-${index}`} data-index={index} key={`${option.value}-${index}`} aria-selected={index === selected} aria-disabled={option.disabled} className={index === active ? 'is-active' : ''} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>{option.label}{index === selected && <span aria-hidden="true">✓</span>}</div>)}
      </div>
    </div>}
  </div>
}
