import { useEffect, useRef, type ReactNode } from 'react'

export default function DocumentActionsMenu({ label, children, trigger, className = '' }: { label: string; children: ReactNode; trigger?: ReactNode; className?: string }) {
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) menu.current?.removeAttribute('open') }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  return <details ref={menu} className={`document-actions-menu ${className}`} onMouseLeave={() => menu.current?.removeAttribute('open')} onKeyDown={event => { if (event.key === 'Escape') { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus() } }}>
    <summary aria-label={label}>{trigger ?? '···'}</summary><div onClick={event => { if ((event.target as HTMLElement).closest('button')) menu.current?.removeAttribute('open') }}>{children}</div>
  </details>
}
