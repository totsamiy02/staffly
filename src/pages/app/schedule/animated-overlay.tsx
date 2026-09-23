import { useCallback, useEffect, useState, type ReactNode } from 'react'

type Props = {
  variant: 'modal' | 'drawer'
  className?: string
  onClose: () => void
  children: (requestClose: () => void) => ReactNode
}

export default function AnimatedOverlay({ variant, className = '', onClose, children }: Props) {
  const [closing, setClosing] = useState(false)
  const requestClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, 180)
  }, [closing, onClose])

  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') requestClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [requestClose])

  const base = variant === 'modal' ? 'schedule-modal' : 'schedule-drawer-backdrop'
  return <div className={`${base}${className ? ` ${className}` : ''}${closing ? ' is-closing' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>{children(requestClose)}</div>
}
