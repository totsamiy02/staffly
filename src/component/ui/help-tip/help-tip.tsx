import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './help-tip.scss'

/** Shared help: hover, keyboard focus and a tap all reveal the same explanation. */
export default function HelpTip({ children, label = 'Пояснение', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), popup = useRef<HTMLSpanElement>(null)
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
  return <span className={`staffly-help ${className}`}>
    <span ref={trigger} role="button" tabIndex={0} aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onPointerEnter={event => { if (event.pointerType !== 'touch') show() }} onPointerLeave={leave} onFocus={show} onBlur={() => setOpen(false)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); show() } }} onClick={event => { event.preventDefault(); event.stopPropagation(); show() }}>?</span>
    {open && createPortal(<span ref={popup} id={id} role="tooltip" className="staffly-help__tip" style={style} onPointerEnter={show} onPointerLeave={leave}>{children}</span>, document.body)}
  </span>
}
