import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export default function RouteAccessibility() {
  const { pathname, hash } = useLocation(), previous = useRef<string | null>(null)
  useEffect(() => {
    if (!hash || pathname === '/guide' || pathname.startsWith('/guide/')) return
    let id: string
    try { id = decodeURIComponent(hash.slice(1)) } catch { return }
    let frame = 0, active = true
    const jump = () => { if (active) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' }) }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(jump) }
    const observer = new MutationObserver(schedule)
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    const stop = () => { active = false; observer.disconnect(); cancelAnimationFrame(frame) }
    for (const event of ['pointerdown', 'wheel', 'touchstart', 'keydown']) document.addEventListener(event, stop, { capture: true, passive: true })
    schedule(); void document.fonts.ready.then(schedule)
    const timeout = setTimeout(stop, 15000)
    return () => { stop(); clearTimeout(timeout); for (const event of ['pointerdown', 'wheel', 'touchstart', 'keydown']) document.removeEventListener(event, stop, true) }
  }, [pathname, hash])
  useEffect(() => {
    const moveFocus = previous.current !== null && previous.current !== pathname
    previous.current = pathname
    if (pathname === '/guide' || pathname.startsWith('/guide/')) return
    let focused = false
    const attach = () => {
      const main = document.querySelector<HTMLElement>('main')
      if (!main || main.matches('.route-loading,.app-loading') || main.querySelector('.route-loading,.app-loading')) return
      main.id ||= 'main-content'; main.tabIndex = -1
      if (moveFocus && !focused) { focused = true; main.focus({ preventScroll: true }); if (!location.hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' }) }
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [pathname])
  if (pathname === '/guide' || pathname.startsWith('/guide/')) return null
  return <a className="skip-content" href="#main-content" onClick={event => { const main = document.querySelector<HTMLElement>('main:not(.route-loading):not(.app-loading)'); if (main) { event.preventDefault(); main.focus(); main.scrollIntoView({ block: 'start' }) } }}>К основному содержимому</a>
}
