import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './dialog-shell.scss'

const overlayStack: symbol[] = []

type Props = {
  variant: 'modal'
  className?: string
  dismissible?: boolean
  onClose: () => void
  children: (requestClose: () => void) => ReactNode
}

export default function AnimatedOverlay({ variant, className = '', dismissible = true, onClose, children }: Props) {
  const identity = useRef(Symbol())
  useEffect(() => { const id = identity.current; overlayStack.push(id); return () => { const index = overlayStack.indexOf(id); if (index >= 0) overlayStack.splice(index, 1) } }, [])
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const requestClose = useCallback(() => {
    if (closing || !dismissible) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose() }, 180)
  }, [closing, dismissible, onClose])

  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])

  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape' && !event.defaultPrevented && overlayStack.at(-1) === identity.current) requestClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [requestClose])

  const base = `schedule-${variant}`
  return createPortal(<div className={`${base}${className ? ` ${className}` : ''}${closing ? ' is-closing' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>{children(requestClose)}</div>, document.body)
}
