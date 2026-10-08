import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

type Props = {
  variant: 'modal' | 'drawer'
  className?: string
  dismissible?: boolean
  onClose: () => void
  children: (requestClose: () => void) => ReactNode
}

export default function AnimatedOverlay({ variant, className = '', dismissible = true, onClose, children }: Props) {
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const requestClose = useCallback(() => {
    if (closing || !dismissible) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose() }, 180)
  }, [closing, dismissible, onClose])

  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])

  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') requestClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [requestClose])

  const base = variant === 'modal' ? 'schedule-modal' : 'schedule-drawer-backdrop'
  return <div className={`${base}${className ? ` ${className}` : ''}${closing ? ' is-closing' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>{children(requestClose)}</div>
}
