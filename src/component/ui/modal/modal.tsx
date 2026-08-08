import type { ReactNode } from 'react'
import './modal.scss'

type ModalProps = {
  isOpen: boolean
  title: string
  children: ReactNode
  actions?: ReactNode
}

function Modal({ isOpen, title, children, actions }: ModalProps) {
  if (!isOpen) return null

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal__content">
        <h2 id="modal-title">{title}</h2>
        <div className="modal__text">{children}</div>
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>
  )
}

export default Modal
