import './operation-status.scss'
import { SupportReference } from './request-error-message.tsx'
import { requestErrorDetails } from '../../app/auth/request-errors.ts'
export type OperationPhase = 'starting' | 'queued' | 'running' | 'ready' | 'downloading' | 'completed' | 'paused' | 'failed'
export type OperationState = { phase: OperationPhase; message?: string; errorId?: string; jobId?: string }
const labels: Record<OperationPhase, string> = { starting: 'Запускаем операцию…', queued: 'Ожидает в очереди', running: 'Выполняется…', ready: 'Файл готов', downloading: 'Скачиваем файл…', completed: 'Завершено', paused: 'Проверка приостановлена', failed: 'Не удалось завершить операцию' }
export default function OperationStatus({ state, onRetry, retryLabel = 'Повторить', onDownload }: { state: OperationState | null; onRetry?: () => void; retryLabel?: string; onDownload?: () => void }) {
  if (!state) return null
  const active = ['starting', 'queued', 'running', 'downloading'].includes(state.phase)
  const details = requestErrorDetails(state.message ?? '')
  const reference = state.errorId ?? details.errorId
  return <section className={'operation-status operation-status--' + state.phase} role={state.phase === 'failed' ? 'alert' : 'status'} aria-live="polite" aria-label="Состояние операции">
    <div><strong className={state.phase === 'failed' ? 'form-inline-error' : undefined}>{active && <span className="app-spinner" aria-hidden="true" />}{labels[state.phase]}</strong>{state.message && <p>{details.message}</p>}
      {reference&&<p className="operation-status__reference"><SupportReference key={reference} value={reference} /></p>}{state.jobId&&state.jobId!==reference&&<p className="operation-status__reference"><SupportReference key={state.jobId} value={state.jobId} label="ID задачи" /></p>}
    </div>
    <div className="operation-status__actions">{onRetry && <button type="button" className="app-secondary" onClick={onRetry}>{retryLabel}</button>}{onDownload && <button type="button" className="app-primary" onClick={onDownload}>Скачать файл</button>}</div>
  </section>
}
