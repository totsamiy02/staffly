import RequestErrorMessage from '../request-error-message.tsx'
import { useState, type ReactNode } from 'react'
import DocumentDialog from './document-dialog.tsx'
import './confirmation-dialog.scss'

export default function ConfirmationDialog({ title, description, resource, children, confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', pendingLabel = 'Сохраняем…', busy = false, disabled = false, error, requiredText, tone = 'danger', onClose, onConfirm, eyebrow = 'Подтверждение', className = '' }: {
  title: string; description?: string; resource?: string; children?: ReactNode; confirmLabel?: string; cancelLabel?: string; pendingLabel?: string; busy?: boolean; disabled?: boolean; error?: string; requiredText?: string; tone?: 'danger' | 'primary'; onClose: () => void; onConfirm: () => void; eyebrow?: string; className?: string
}) {
  const [confirmation, setConfirmation] = useState('')
  return <DocumentDialog title={title} eyebrow={eyebrow} onClose={onClose} busy={busy} className={'confirmation-dialog ' + className}>
    <div className="confirmation-dialog__content">
      {resource && <div className="confirmation-dialog__resource">{resource}</div>}
      {description && <p>{description}</p>}
      {children}
      {requiredText && <label className="confirmation-dialog__field"><span>Для подтверждения введите название</span><input autoComplete="off" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      {error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}
    </div>
    <footer><button type="button" className="app-secondary" disabled={busy} onClick={onClose}>{cancelLabel}</button><button type="button" className={tone === 'danger' ? 'app-danger' : 'app-primary'} disabled={busy || disabled || !!requiredText && confirmation !== requiredText} onClick={onConfirm}>{busy ? pendingLabel : confirmLabel}</button></footer>
  </DocumentDialog>
}
