import { readTabValue, writeTabValue, removeTabValue } from '../../workspace/tab-storage.ts'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/auth-context.tsx'
import type { ReportInput } from './reporting.ts'
import type { OperationState } from '../../../component/ui/operation-status.tsx'
type Job = { id: string; status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED'; statusUrl: string; message?: string; errorId?: string; expiresAt: string }
type Intent = { requestKey: string; userId: string; organizationId: string; input: ReportInput; job?: Job; createdAt: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function readIntent(key: string, userId: string, organizationId: string): Intent | null {
  try {
    const value = JSON.parse(readTabValue(key) ?? 'null') as Intent | null
    return value && value.userId === userId && value.organizationId === organizationId && uuid.test(value.requestKey) && (!value.job || uuid.test(value.job.id)) && Date.now() - value.createdAt < 3600000 && value.createdAt <= Date.now() && value.input && typeof value.input === 'object' ? value : null
  } catch { return null }
}
export function useReportExport(organizationId: string) {
  const { user, apiRequest, downloadFile } = useAuth()
  const userId = user?.id ?? '', key = 'staffly:report-job:' + userId + ':' + organizationId
  const [intent, setIntent] = useState<Intent | null>(() => readIntent(key, userId, organizationId))
  const [state, setState] = useState<OperationState | null>(() => intent ? { phase: 'queued', message: 'Восстанавливаем состояние предыдущей выгрузки.', jobId: intent.job?.id } : null)
  const [submitting, setSubmitting] = useState(false), [recoverable, setRecoverable] = useState(true)
  const lock = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (intent) setRecoverable(writeTabValue(key, JSON.stringify(intent))); else removeTabValue(key)
  }, [key, intent])
  const base = '/organizations/' + organizationId + '/statistics/reports'
  const path = intent?.job ? base + '/exports/' + intent.job.id : base + '/exports/request/' + intent?.requestKey
  const query = useQuery({
    queryKey: ['report-export-progress', userId, organizationId, intent?.requestKey],
    queryFn: ({ signal }) => apiRequest<Job>(path, { signal }),
    enabled: !!intent && !submitting && state?.phase !== 'completed' && state?.phase !== 'downloading' && state?.phase !== 'paused' && state?.phase !== 'failed',
    retry: false,
    refetchInterval: result => ['PENDING', 'RUNNING'].includes(result.state.data?.status ?? '') ? 1500 : false,
    staleTime: 0,
  })
  useEffect(() => {
    const job = query.data
    if (!job || submitting || !intent || !mounted.current) return
    if (!uuid.test(job.id)) { setState({ phase: 'failed', message: 'Некорректный ответ сервера.' }); return }
    if (intent.job?.id !== job.id) setIntent(current => current ? { ...current, job } : null)
    if (job.status === 'FAILED') setState({ phase: 'failed', message: job.message ?? 'Выгрузка не завершена. Параметры сохранены, можно повторить.', errorId: job.errorId ?? job.id, jobId: job.id })
    else if (job.status === 'READY') setState({ phase: 'ready', message: 'Отчёт за ' + intent.input.from + ' — ' + intent.input.to + (recoverable ? ' готов к скачиванию.' : ' готов. Скачайте файл перед закрытием: номер операции не сохраняется в браузере.'), jobId: job.id })
    else setState({ phase: job.status === 'PENDING' ? 'queued' : 'running', message: recoverable ? 'Можно закрыть окно. При следующем открытии состояние восстановится в этой вкладке.' : 'Браузер не сохраняет номер операции. Оставьте окно открытым до скачивания файла.', jobId: job.id })
  }, [query.data, query.dataUpdatedAt, submitting, intent, recoverable])
  useEffect(() => {
    if (!query.error || !intent) return
    const error = query.error as Error & { status?: number; errorId?: string }
    const denied = [401, 403, 404].includes(error.status ?? 0) && !!intent.job
    setState({ phase: denied ? 'failed' : 'paused', message: denied ? error.message : 'Не удалось получить состояние. Операция могла продолжиться на сервере. Повторная проверка сохранит тот же номер выгрузки.', errorId: error.errorId, jobId: intent.job?.id })
  }, [query.error, intent])
  async function submit(next: Intent) {
    if (lock.current) return
    lock.current = true; setSubmitting(true); setIntent(next); setState({ phase: 'starting' })
    // Persist the original parameters/key before sending: a lost response must not create another job.
    setRecoverable(writeTabValue(key, JSON.stringify(next)))
    try {
      const { job } = await apiRequest<{ job: Job }>(base + '/export', { method: 'POST', body: { ...next.input, requestKey: next.requestKey } })
      if (mounted.current) { setIntent({ ...next, job }); setState({ phase: 'queued', jobId: job.id }) }
    } catch (failure) {
      const error = failure as Error & { status?: number; errorId?: string }
      if (mounted.current) setState({ phase: error.status && error.status < 500 ? 'failed' : 'paused', message: error.message || 'Связь прервалась. Можно проверить или повторить запуск с тем же номером.', errorId: error.errorId })
    } finally { lock.current = false; if (mounted.current) setSubmitting(false) }
  }
  async function download() {
    const job = query.data ?? intent?.job
    if (!job || !uuid.test(job.id) || lock.current) return
    lock.current = true; setState({ phase: 'downloading', jobId: job.id })
    try {
      await downloadFile(base + '/exports/' + job.id + '/content', 'Staffly_' + intent!.input.from + '_' + intent!.input.to + '.xlsx')
      if (mounted.current) setState({ phase: 'completed', message: 'Файл передан браузеру. При необходимости его можно скачать ещё раз.', jobId: job.id })
    } catch (failure) {
      const error = failure as Error & { errorId?: string }
      if (mounted.current) setState({ phase: 'paused', message: error.message, errorId: error.errorId, jobId: job.id })
    } finally { lock.current = false }
  }
  return {
    state, recoverable,
    active: ['starting', 'queued', 'running', 'downloading'].includes(state?.phase ?? ''),
    start: (input: ReportInput) => submit({ requestKey: crypto.randomUUID(), input: structuredClone(input), userId, organizationId, createdAt: Date.now() }),
    async retry() {
      if (!intent) return
      if (state?.phase === 'failed') await submit({ ...intent, job: undefined, requestKey: crypto.randomUUID(), createdAt: Date.now() })
      else if (!intent.job) await submit(intent)
      else { setState({ phase: 'queued', jobId: intent.job.id }); await query.refetch() }
    },
    download,
  }
}
