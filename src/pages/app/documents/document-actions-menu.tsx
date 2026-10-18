import { useEffect, useId, useRef, type ReactNode } from 'react'

export default function DocumentActionsMenu({ label, children, trigger, className = '', closeOnSelect = true, closeOnMouseLeave = true }: { label: string; children: ReactNode; trigger?: ReactNode; className?: string; closeOnSelect?: boolean; closeOnMouseLeave?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null)
  const id = useId()
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) menu.current?.removeAttribute('open') }
    const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== id && !menu.current?.contains(document.activeElement)) menu.current?.removeAttribute('open') }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('staffly:popover-open', otherOpened)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('staffly:popover-open', otherOpened) }
  }, [id])
  return <details ref={menu} className={`document-actions-menu ${className}`} onToggle={event => { if (event.currentTarget.open) document.dispatchEvent(new CustomEvent('staffly:popover-open', { detail: id })) }} onMouseLeave={() => { if (closeOnMouseLeave) menu.current?.removeAttribute('open') }} onKeyDown={event => { if (event.key === 'Escape') { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus() } }}>
    <summary aria-label={label}>{trigger ?? <svg className="actions-menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>}</summary><div onClick={event => { if ((event.target as HTMLElement).closest('a') || closeOnSelect && (event.target as HTMLElement).closest('button')) menu.current?.removeAttribute('open') }}>{children}</div>
  </details>
}
