import { useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import './segmented-nav.scss'

/** Shared navigation for existing buttons and router links; selection stays with the caller. */
export default function SegmentedNav({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLElement>(null)
  const [indicator, setIndicator] = useState<CSSProperties>({ opacity: 0 })
  useLayoutEffect(() => {
    const nav = ref.current
    if (!nav) return
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('a.active, button.active, button[aria-pressed="true"], button[aria-selected="true"]')
      if (!active) { setIndicator({ opacity: 0 }); return }
      setIndicator({ width: active.offsetWidth, height: active.offsetHeight, transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`, opacity: 1 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(nav)
    Array.from(nav.children).forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [children])
  return <nav ref={ref} className="staffly-segmented" aria-label={label}><span className="staffly-segmented__indicator" style={indicator} aria-hidden="true" />{children}</nav>
}
