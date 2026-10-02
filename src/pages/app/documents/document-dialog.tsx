import { useEffect, useRef, type ReactNode } from 'react'
import './documents.scss'
// Focus handling is shared by every dialog in this module, including the drawer.
export default function DocumentDialog({ title, onClose, children, drawer = false, busy = false, viewer = false, className = '', eyebrow = 'Документы', headerContent, onEscape }: { title: string; onClose: () => void; children: ReactNode; drawer?: boolean; busy?: boolean; viewer?: boolean; className?: string; eyebrow?: string; headerContent?: ReactNode; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const original = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus(); return () => { document.body.style.overflow = original; previous?.focus() } }, [])
  return <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`${viewer ? 'document-viewer' : drawer ? 'schedule-drawer document-drawer' : 'request-modal document-dialog'} ${className}`} onKeyDown={event => {
    if (event.key === 'Escape' && onEscape) { event.stopPropagation(); onEscape(); return }
    if (event.key !== 'Tab') return
    const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled):not([aria-hidden=true]), textarea:not(:disabled), [tabindex="0"]')
    const visible = Array.from(items ?? []).filter(item => item.getClientRects().length > 0)
    if (!visible.length) { event.preventDefault(); return }
    const first = visible[0], last = visible.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
  }}>{headerContent ?? <header><div><p className="app-eyebrow">{eyebrow}</p><h2>{title}</h2></div><button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button></header>}{children}</div>
}
