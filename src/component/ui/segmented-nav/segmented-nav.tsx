import { useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import './segmented-nav.scss'

type IndicatorGeometry = { width: number; height: number; transform: string }
const rememberedIndicators = new Map<string, IndicatorGeometry>()

/** Shared navigation for existing buttons and router links; selection stays with the caller. */
export default function SegmentedNav({ children, label, variant = 'segmented', className = '', continuityKey }: { children: ReactNode; label: string; variant?: 'segmented' | 'underline'; className?: string; continuityKey?: string }) {
  const ref = useRef<HTMLElement>(null)
  const [indicator, setIndicator] = useState<CSSProperties>({ opacity: 0 })
  const measured = useRef(false)
  useLayoutEffect(() => {
    const nav = ref.current
    if (!nav) return
    let lastWidth = nav.clientWidth, lastHeight = nav.clientHeight
    const measure = (resizing = false) => {
      const active = nav.querySelector<HTMLElement>('a.active, button.active, button[aria-pressed="true"], button[aria-selected="true"]')
      if (!active) { setIndicator({ opacity: 0 }); return }
      const next = { width: active.offsetWidth, height: variant === 'underline' ? 2 : active.offsetHeight, transform: `translate(${active.offsetLeft}px, ${active.offsetTop + (variant === 'underline' ? active.offsetHeight - 2 : 0)}px)`, opacity: 1, transition: measured.current && !resizing ? undefined : 'none' }
      if (!measured.current && continuityKey && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const previous = rememberedIndicators.get(continuityKey)
        if (previous && (previous.transform !== next.transform || previous.width !== next.width)) {
          nav.querySelector('.staffly-segmented__indicator')?.animate([{ ...previous, width: `${previous.width}px`, height: `${previous.height}px`, opacity: 1 }, { width: `${next.width}px`, height: `${next.height}px`, transform: next.transform, opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' })
        }
      }
      if (continuityKey) { rememberedIndicators.set(continuityKey, { width: next.width, height: next.height, transform: next.transform }); if (rememberedIndicators.size > 30) rememberedIndicators.delete(rememberedIndicators.keys().next().value!) }
      setIndicator(previous => previous.width === next.width && previous.height === next.height && previous.transform === next.transform && previous.opacity === next.opacity && previous.transition === next.transition ? previous : next)
      measured.current = true
    }
    measure()
    const observer = new ResizeObserver(() => { const resized = nav.clientWidth !== lastWidth || nav.clientHeight !== lastHeight; lastWidth = nav.clientWidth; lastHeight = nav.clientHeight; measure(resized) })
    observer.observe(nav)
    Array.from(nav.children).filter(element => !element.classList.contains('staffly-segmented__indicator')).forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [children, continuityKey, variant])
  return <nav ref={ref} className={`staffly-segmented${variant === 'underline' ? ' staffly-segmented--underline' : ''} ${className}`} aria-label={label}><span className="staffly-segmented__indicator" style={indicator} aria-hidden="true" />{children}</nav>
}
