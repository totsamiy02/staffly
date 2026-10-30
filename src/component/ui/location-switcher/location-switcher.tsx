import { useEffect, useId, useRef, useState } from 'react'
import { locationTone } from '../../../app/organizations/format.ts'
import './location-switcher.scss'

type Point = { id: string; name: string; address?: string | null; archivedAt?: string | null }
export default function LocationSwitcher({ points, value, onChange, onOpen, totalPoints = points.length, compact = false }: { points: Point[]; value: string; onChange: (id: string) => void; onOpen?: () => void; totalPoints?: number; compact?: boolean }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState('')
  const host = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), id = useId()
  const selected = points.find(point => point.id === value)
  const pointWord = new Intl.PluralRules('ru-RU').select(totalPoints)
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  function select(point: Point) { onChange(point.id); setOpen(false); setSearch('') }
  const filtered = points.filter(point => `${point.name} ${point.address ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  if (points.length <= 4 && !compact) return <div className="location-switcher location-switcher--inline" role="group" aria-label="Точки организации">{points.map(point => <button className="location-choice" type="button" key={point.id} title={point.name} aria-label={point.name} data-tone={locationTone(point.id)} aria-pressed={point.id === value} onClick={() => select(point)}><span className="location-choice__dot" /><span>{point.name}</span>{point.archivedAt && <small>Закрыта</small>}</button>)}</div>
  return <div className="location-switcher" ref={host}>
    <button type="button" className="location-switcher__trigger" title={selected?.name} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { setSearch(''); setOpen(!open); if (!open) onOpen?.() }}><span className="location-choice__dot" data-tone={locationTone(value)} /><span><strong>{selected?.name ?? 'Выберите точку'}</strong><small>{totalPoints} {pointWord === 'one' ? 'точка' : pointWord === 'few' ? 'точки' : 'точек'} организации</small></span><span aria-hidden="true">⌄</span></button>
    {open && <section className="location-switcher__popover" id={id} role="dialog" aria-label="Выбор точки" onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); host.current?.querySelector<HTMLButtonElement>('button')?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = [...host.current?.querySelectorAll<HTMLButtonElement>('.location-switcher__list button') ?? []], index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
    }}><input ref={input} type="search" aria-label="Найти точку" placeholder="Название или адрес" value={search} onChange={event => setSearch(event.target.value)} /><div className="location-switcher__list">{filtered.map(point => <button className="location-choice" type="button" key={point.id} data-tone={locationTone(point.id)} aria-pressed={point.id === value} onClick={() => select(point)}><span className="location-choice__dot" /><span><strong>{point.name}</strong><small>{point.archivedAt ? 'Закрытая точка' : point.address || 'Адрес не указан'}</small></span><span aria-hidden="true">{point.id === value ? '✓' : ''}</span></button>)}{!filtered.length && <p>Точка не найдена</p>}</div></section>}
  </div>
}
