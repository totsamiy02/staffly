import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { SelfExitPreview } from '../../../shared/self-exit.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import { RequestErrorState } from '../../../component/ui/request-error-message.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import './self-exit.scss'

export function ExitIcon({ kind = 'exit' }: { kind?: 'exit' | 'lock' | 'file' | 'warning' }) {
  return <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {kind === 'exit' && <path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9" />}
    {kind === 'lock' && <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4" />
    </>}
    {kind === 'file' && <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" />}
    {kind === 'warning' && <path d="m12 3 10 18H2zM12 9v4M12 17h.01" />}
  </svg>
}

export default function SelfExitDialog({ organizationId, onClose, onCompleted }: {
  organizationId: string
  onClose: () => void
  onCompleted: (name: string) => void
}) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  // Keep the submitted employment period through a lost response or live refresh.
  // A retry must finish the same operation, never target a later rehire.
  const [submitted, setSubmitted] = useState<SelfExitPreview | null>(null)
  const query = useQuery({
    queryKey: ['self-exit-preview', organizationId],
    queryFn: () => apiRequest<SelfExitPreview>(`/organizations/${organizationId}/leave`),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: !submitted,
  })
  const data = submitted ?? (query.isSuccess ? query.data : undefined)
  const mutation = useMutation({
    mutationFn: (operation: SelfExitPreview) => apiRequest(`/organizations/${organizationId}/leave`, {
      method: 'POST', body: { employmentPeriodId: operation.employmentPeriodId },
    }),
    onSuccess: async (_result, operation) => {
      await client.cancelQueries({ predicate: item => item.queryKey[1] === organizationId })
      client.removeQueries({ predicate: item => item.queryKey[1] === organizationId })
      await Promise.all(['organizations', 'notifications', 'account-notifications'].map(key =>
        client.invalidateQueries({ queryKey: [key] }),
      ))
      onCompleted(operation.organization.name)
    },
  })
  const errorCode = (mutation.error as { code?: string } | null)?.code
  const changed = ['MEMBERSHIP_CHANGED', 'OWNER_MUST_TRANSFER'].includes(errorCode ?? '')
  const refresh = () => {
    mutation.reset()
    setSubmitted(null)
    void query.refetch()
  }
  const busy = mutation.isPending
  const title = data?.owner ? 'Сначала передайте владение' : 'Покинуть организацию?'
  return <AnimatedOverlay variant="modal" dismissible={!busy} onClose={onClose}>
    {close =>
      <DocumentDialog
        title={title}
        eyebrow="Участие в организации"
        className="self-leave-dialog"
        scrollBody
        busy={busy}
        onClose={close}
        footer={<footer className="self-leave-footer">
          <button className="app-secondary" disabled={busy} onClick={close}>
            {data?.owner ? 'Остаться' : 'Отмена'}
          </button>
          {data?.owner ? <Link className="app-primary" to={`/app/organizations/${organizationId}/settings?section=access`}>Передать владение</Link>
            : data && <button
              className="app-danger"
              disabled={busy || changed || query.isFetching}
              onClick={() => { setSubmitted(data); mutation.mutate(data) }}
            >
              <ExitIcon />
              {busy ? 'Выходим…' : mutation.isError && !changed ? 'Повторить выход' : 'Покинуть организацию'}
            </button>}
        </footer>}
      >
        {query.isPending && !submitted && <p className="self-exit-loading" role="status">Проверяем участие и рабочие назначения…</p>}
        {query.isError && !submitted && <RequestErrorState error={query.error} onRetry={() => void query.refetch()} />}
        {data && <>
          <div className="leave-identity">
            <Avatar
              url={data.organization.logoUrl}
              name={data.organization.name}
              className="leave-identity__avatar"
              eager
            />
            <div>
              <strong>
                {data.organization.name}
              </strong>
              <p>
                {data.owner ? 'Вы — владелец организации' : `Вы — участник организации · Рабочих точек: ${data.locationCount}`}
              </p>
            </div>
          </div>
          {data.owner ? <>
            <p className="leave-intro">У организации должен оставаться владелец. Передайте владение другому сотруднику, после этого сможете выйти.</p>
            <p className="leave-return">Выберите нового владельца в настройках организации.</p>
          </> : <>
            <p className="leave-intro">После выхода вы потеряете доступ ко всем точкам этой организации на всех устройствах.</p>
            <div className="leave-consequences">
              <div>
                <span>
                  <ExitIcon kind="lock" />
                </span>
                <section>
                  <strong>Доступ к организации закроется</strong>
                  <p>Ваш аккаунт и другие организации останутся доступны.</p>
                </section>
              </div>
              <div>
                <span>
                  <ExitIcon kind="file" />
                </span>
                <section>
                  <strong>Рабочая история сохранится</strong>
                  <p>Смены, часы, табели и документы останутся у организации.</p>
                </section>
              </div>
            </div>
            {(data.shifts + data.tasks + data.reviews) > 0 && <div className="leave-warning">
              <ExitIcon kind="warning" />
              <div>
                <strong>Останутся рабочие вопросы</strong>
                <p>Будущих смен: {data.shifts}. Незавершённых задач: {data.tasks}.{data.reviews > 0 && ` Заявок на согласовании: ${data.reviews}.`} Руководитель получит уведомление и сможет назначить замену.</p>
              </div>
            </div>}
            <p className="leave-return">Чтобы вернуться, понадобится новое приглашение.</p>
          </>}
        </>}
        {mutation.isError && <div className="self-exit-error" role="alert">
          <RequestErrorMessage error={mutation.error} />
          {changed && <button className="app-secondary" onClick={refresh}>Обновить данные</button>}
        </div>}
      </DocumentDialog>
    }
  </AnimatedOverlay>
}
