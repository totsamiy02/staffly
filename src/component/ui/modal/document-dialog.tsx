import { useEffect, useRef, type ReactNode } from 'react'
import '../../../pages/app/documents/documents.scss'
import './dialog-shell.scss'
import { lockBodyScroll } from '../body-scroll-lock.ts'
// Shared focus handling, scroll locking and shell for centered app dialogs.
export default function DocumentDialog({ title, onClose, children, scrollBody = false, description, busy = false, viewer = false, className = '', eyebrow = 'Документы', headerContent, onEscape }: { title: string; onClose: () => void; children: ReactNode; scrollBody?: boolean; description?: string; busy?: boolean; viewer?: boolean; className?: string; eyebrow?: string; headerContent?: ReactNode; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const release = lockBodyScroll(); ref.current?.focus(); return () => { release(); if (previous?.isConnected) previous.focus() } }, [])
  return <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`${viewer ? 'document-viewer' : 'request-modal document-dialog'}${scrollBody ? ' document-dialog--scroll' : ''} ${className}`} onKeyDown={event => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && onEscape) { event.stopPropagation(); onEscape(); return }
    if (event.key !== 'Tab') return
    const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled):not([aria-hidden=true]), textarea:not(:disabled), [tabindex="0"]')
    const visible = Array.from(items ?? []).filter(item => item.getClientRects().length > 0)
    if (!visible.length) { event.preventDefault(); return }
    const first = visible[0], last = visible.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
  }}>{headerContent ?? <header><div><p className="app-eyebrow">{eyebrow}</p><h2>{title}</h2>{description && <p className="document-dialog__description">{description}</p>}</div><button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button></header>}{scrollBody ? <div className="document-dialog__body" tabIndex={0} aria-label={`${title}: содержимое`}>{children}</div> : children}</div>
}
