import { useRef, type ReactNode } from 'react'
import '../../../pages/app/documents/documents.scss'
import './dialog-shell.scss'
import { useDialogFocus } from './dialog-focus.ts'
// Shared focus handling, scroll locking and shell for centered app dialogs.
export default function DocumentDialog({ title, onClose, children, scrollBody = false, description, busy = false, viewer = false, className = '', eyebrow = 'Документы', headerContent, onEscape, formRef }: { title: string; onClose: () => void; children: ReactNode; scrollBody?: boolean; description?: string; busy?: boolean; viewer?: boolean; className?: string; eyebrow?: string; headerContent?: ReactNode; onEscape?: () => void; formRef?: (element: HTMLDivElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  return <div ref={element => { ref.current = element; formRef?.(element) }} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`${viewer ? 'document-viewer' : 'request-modal document-dialog'}${scrollBody ? ' document-dialog--scroll' : ''} ${className}`} onKeyDown={event => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && onEscape) { event.stopPropagation(); onEscape(); return }
  }}>{headerContent ?? <header><div><p className="app-eyebrow">{eyebrow}</p><h2>{title}</h2>{description && <p className="document-dialog__description">{description}</p>}</div><button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button></header>}{scrollBody ? <div className="document-dialog__body" role="region" tabIndex={0} aria-label={`${title}: содержимое`}>{children}</div> : children}</div>
}
