import { useRef, useState } from 'react'
import { requestErrorDetails, supportIdPattern } from '../../app/auth/request-errors.ts'
import './request-error-message.scss'

export function SupportReference({ value, label = 'Код для поддержки' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState('')
  const code = useRef<HTMLElement>(null)
  if (!supportIdPattern.test(value)) return null
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied('Скопировано') }
    catch {
      // Clipboard can be unavailable without HTTPS or denied by the browser.
      if (code.current) {
        code.current.focus()
        const range = document.createRange(); range.selectNodeContents(code.current)
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      }
      setCopied('Выделен — скопируйте вручную')
    }
  }
  return <span className="request-error-reference" title="Передайте код, время сбоя и описание действия администратору.">
    <span>{label}: <code ref={code} tabIndex={-1}>{value}</code></span>
    <button type="button" className="request-error-reference__copy" aria-label={`Скопировать ${label.toLowerCase()}`} onClick={() => void copy()}>Копировать</button>
    <span className="request-error-reference__feedback" role="status">{copied}</span>
  </span>
}

/** Also accepts existing form/toast states that hold error.message. */
export default function RequestErrorMessage({ error }: { error: unknown }) {
  const { message, errorId } = requestErrorDetails(error)
  return <span className="request-error-message"><span>{message}</span>{errorId && <SupportReference key={errorId} value={errorId} />}</span>
}

export function RequestErrorState({ error, onRetry, className = '' }: { error: unknown; onRetry: () => void; className?: string }) {
  return <div className={`request-error-state ${className}`} role="alert"><p><RequestErrorMessage error={error} /></p><button type="button" className="app-secondary" onClick={onRetry}>Повторить</button></div>
}
