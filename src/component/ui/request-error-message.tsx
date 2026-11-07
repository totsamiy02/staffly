import { supportReportPending } from '../../app/support/client-diagnostics.ts'
import { useEffect, useState } from 'react'
import CopyReference from './copy-reference.tsx'
import { requestErrorDetails, supportIdPattern } from '../../app/auth/request-errors.ts'
import './request-error-message.scss'

export function SupportReference({ value, label = 'Код для поддержки' }: { value: string; label?: string }) {
  const [pending,setPending]=useState(()=>supportReportPending(value))
  useEffect(()=>{const update=()=>setPending(supportReportPending(value));window.addEventListener('staffly:support-delivery',update);return()=>window.removeEventListener('staffly:support-delivery',update)},[value])
  if (!supportIdPattern.test(value)) return null
  return <span className="request-error-reference" title="Передайте код, время сбоя и описание действия администратору.">
    <CopyReference value={value} label={label}/>
    {pending&&<span className="request-error-reference__feedback" role="status">Код отправится в поддержку после восстановления связи.</span>}
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
