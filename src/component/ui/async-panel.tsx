import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './async-panel.scss'

function PendingPanel({ label }: { label: string }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const timer = window.setTimeout(() => setVisible(true), 180); return () => window.clearTimeout(timer) }, [])
  return <div className={`async-panel__pending${visible ? ' is-visible' : ''}`} role="status" aria-label={label}><span /><span /><span /></div>
}

/** Keeps layout steady without showing stale rows under new filters. */
export default function AsyncPanel({ pending, identity = '', minHeight = 240, label = 'Загружаем раздел', className = '', children }: { pending: boolean; identity?: string; minHeight?: number; label?: string; className?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), lastHeight = useRef(0)
  const paginationFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const element = root.current, body = content.current
    if (!element || !body) return
    element.style.minHeight = `${pending ? Math.max(minHeight, lastHeight.current) : minHeight}px`
    if (pending) return
    if (paginationFocus.current && document.activeElement === document.body) {
      const button = Array.from(body.querySelectorAll<HTMLButtonElement>('.members-pagination button, .document-pagination button')).find(button => !button.disabled && button.textContent === paginationFocus.current)
      button?.focus({ preventScroll: true })
    }
    const nextHeight = Math.max(minHeight, body.getBoundingClientRect().height), previousHeight = lastHeight.current
    lastHeight.current = nextHeight
    const animations: Animation[] = []
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (previousHeight && Math.abs(previousHeight - nextHeight) > 1) animations.push(element.animate([{ height: `${previousHeight}px`, overflow: 'clip' }, { height: `${nextHeight}px`, overflow: 'clip' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }))
      animations.push(body.animate([{ opacity: .35, transform: 'translate3d(12px,0,0)' }, { opacity: 1, transform: 'translate3d(0,0,0)' }], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' }))
    }
    const observer = new ResizeObserver(() => { lastHeight.current = Math.max(minHeight, body.getBoundingClientRect().height) })
    observer.observe(body)
    return () => { observer.disconnect(); animations.forEach(animation => animation.cancel()) }
  }, [pending, identity, minHeight])
  return <div ref={root} className={`async-panel ${className}`} style={{ minHeight }} aria-busy={pending} onFocusCapture={event => { const target = event.target as HTMLElement; paginationFocus.current = target.closest('.members-pagination, .document-pagination') ? target.textContent : null }}><div ref={content} className="async-panel__content">{pending ? <PendingPanel label={label} /> : children}</div></div>
}
