import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export default function RouteAccessibility() {
  const { pathname } = useLocation(), previous = useRef<string | null>(null)
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
