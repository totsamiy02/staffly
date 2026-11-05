import './operation-status.scss'
export type OperationPhase = 'starting' | 'queued' | 'running' | 'ready' | 'downloading' | 'completed' | 'paused' | 'failed'
export type OperationState = { phase: OperationPhase; message?: string; errorId?: string; jobId?: string }
const labels: Record<OperationPhase, string> = { starting: 'Запускаем операцию…', queued: 'Ожидает в очереди', running: 'Выполняется…', ready: 'Файл готов', downloading: 'Скачиваем файл…', completed: 'Завершено', paused: 'Проверка приостановлена', failed: 'Не удалось завершить операцию' }
export default function OperationStatus({ state, onRetry, retryLabel = 'Повторить', onDownload }: { state: OperationState | null; onRetry?: () => void; retryLabel?: string; onDownload?: () => void }) {
  if (!state) return null
  const active = ['starting', 'queued', 'running', 'downloading'].includes(state.phase)
  return <section className={'operation-status operation-status--' + state.phase} role={state.phase === 'failed' ? 'alert' : 'status'} aria-live="polite" aria-label="Состояние операции">
    <div><strong className={state.phase === 'failed' ? 'form-inline-error' : undefined}>{active && <span className="app-spinner" aria-hidden="true" />}{labels[state.phase]}</strong>{state.message && <p>{state.message}</p>}
      {(state.errorId || state.jobId) && <p className="operation-status__reference">{state.errorId ? 'Код для поддержки' : 'Номер операции'}: <code>{state.errorId ?? state.jobId}</code></p>}
    </div>
    <div className="operation-status__actions">{onRetry && <button type="button" className="app-secondary" onClick={onRetry}>{retryLabel}</button>}{onDownload && <button type="button" className="app-primary" onClick={onDownload}>Скачать файл</button>}</div>
  </section>
}
