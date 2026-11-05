import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './dialog-focus.ts'
import './modal.scss'
import './dialog-shell.scss'

type ModalProps = {
  isOpen: boolean
  title: string
  children: ReactNode
  actions?: ReactNode
}

function Modal({ isOpen, title, children, actions }: ModalProps) {
  const titleId = useId(), ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref, isOpen)
  if (!isOpen) return null

  return createPortal(
    <div className="modal">
      <div ref={ref} tabIndex={-1} className="modal__content" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <div className="modal__text">{children}</div>
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>, document.body
  )
}

export default Modal
