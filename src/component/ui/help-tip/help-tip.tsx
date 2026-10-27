import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './help-tip.scss'

/** Shared help: hover, keyboard focus and a tap all reveal the same explanation. */
export default function HelpTip({ children, label = 'Пояснение', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false), [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  function show() { if (timer.current) clearTimeout(timer.current); setOpen(true) }
  function leave() { if (document.activeElement === trigger.current) return; timer.current = setTimeout(() => setOpen(false), 120) }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useLayoutEffect(() => {
    if (!open) return
    const rect = trigger.current?.getBoundingClientRect(), height = popup.current?.offsetHeight ?? 80
    if (rect) setStyle({ position: 'fixed', width: Math.min(280, window.innerWidth - 24), left: Math.max(12, Math.min(rect.left - 12, window.innerWidth - 292)), top: rect.bottom + height + 18 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8), visibility: 'visible' })
    function close() { setOpen(false) }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    function outside(event: PointerEvent) { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close() }
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close)
    document.addEventListener('keydown', escape, true); document.addEventListener('pointerdown', outside, true)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); document.removeEventListener('keydown', escape, true); document.removeEventListener('pointerdown', outside, true) }
  }, [open])
  // A native button here would become the implicit control of an enclosing field label.
  return <span className={`staffly-help ${className}`}>
    <span role="button" tabIndex={0} className="staffly-help__trigger" ref={trigger} aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onPointerEnter={event => { if (event.pointerType !== 'touch') show() }} onPointerLeave={leave} onFocus={show} onBlur={() => setOpen(false)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); show() } }} onClick={event => { event.preventDefault(); event.stopPropagation(); show() }}><svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M8 7.5a2 2 0 1 1 3.4 1.4c-.8.5-1.4.8-1.4 2.1" /><path d="M10 13.5h.01" /></svg></span>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="staffly-help__tip" style={style} onPointerEnter={show} onPointerLeave={leave}>{children}</div>, document.body)}
  </span>
}
