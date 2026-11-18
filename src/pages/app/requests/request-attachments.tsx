import ConfirmationDialog from '../../../component/ui/modal/confirmation-dialog.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import { useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { StaffRequest } from '../../../app/requests/types.ts'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { sizeLabel } from './request-format.ts'

export default function RequestAttachments({ attachments, events, canRemove, organizationId, requestId }: { attachments: StaffRequest['attachments']; events: StaffRequest['events']; canRemove: boolean; organizationId: string; requestId: string }) {
  const { apiRequest, downloadFile, previewFile } = useAuth()
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<{ id: string; url: string; mimeType: string } | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  useToastFeedback('', error)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  useFormSafety({
    scope: 'request-file-delete:' + organizationId + ':' + requestId,
    value: {},
    dirty: false,
    busy: !!removingId
  })
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url)
  }, [preview])
  async function open(attachment: StaffRequest['attachments'][number]) {
    setLoadingId(attachment.id)
    setError('')
    try {
      const blob = await previewFile(attachment.downloadUrl.replace('/api', ''))
      setPreview({
        id: attachment.id,
        url: URL.createObjectURL(blob),
        mimeType: attachment.mimeType
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось открыть файл.')
    }
    finally {
      setLoadingId(null)
    }
  }
  async function remove(attachment: StaffRequest['attachments'][number]) {
    setRemovingId(attachment.id)
    setError('')
    try {
      await apiRequest(attachment.downloadUrl.replace('/api', ''), { method: 'DELETE' })
      if (preview?.id === attachment.id) setPreview(null)
      await Promise.all(['request', 'requests', 'document-request-files', 'organization-resources'].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось удалить вложение.')
    }
    finally {
      setRemovingId(null)
      setConfirmId(null)
    }
  }
  const removed = events.filter(event => event.comment?.startsWith('Удалён файл: ')).slice(-5)
  return <section className="request-detail-block">
    <h3>Вложения</h3>
    <div className="request-attachments">
      {attachments.map((attachment) => <div className="request-attachment" key={attachment.id}>
        <div>
          <strong>
            {attachment.fileName}
          </strong>
          <small>
            {sizeLabel(attachment.size)}
          </small>
        </div>
        <button
          type="button"
          disabled={loadingId === attachment.id}
          onClick={() => void open(attachment)}>
          {loadingId === attachment.id ? 'Открываем…' : 'Посмотреть'}
        </button>
        <button type="button" onClick={() => void downloadFile(attachment.downloadUrl.replace('/api', ''), attachment.fileName)}>Скачать</button>
        {canRemove && <button
          type="button"
          disabled={removingId === attachment.id}
          onClick={() => {
            setError('')
            setConfirmId(attachment.id)
          }}>Удалить</button>}
      </div>)}
    </div>
    {error && <p className="form-inline-error" role="alert">
      {error}
    </p>}
    {preview && <div className="request-preview">
      <div>
        <strong>
          {attachments.find((item) => item.id === preview.id)?.fileName}
        </strong>
        <button
          type="button"
          onClick={() => setPreview(null)}
          aria-label="Закрыть просмотр">×</button>
      </div>
      {preview.mimeType === 'application/pdf' ? <iframe title="Просмотр PDF" src={preview.url} /> : <img src={preview.url} alt="Предпросмотр вложения" />}
    </div>}
    {removed.length > 0 && <div className="request-removed-attachments" aria-label="Удалённые вложения">
      {removed.map(event => <p key={event.id}>
        <span>Удалено</span>
        {event.comment?.slice('Удалён файл: '.length)}
      </p>)}
    </div>}
    {confirmId && attachments.find(file => file.id === confirmId) && <AnimatedOverlay
      variant="modal"
      dismissible={!removingId}
      onClose={() => setConfirmId(null)}>
      {close => <ConfirmationDialog
        title="Удалить вложение?"
        resource={attachments.find(file => file.id === confirmId)!.fileName}
        requiredText={attachments.find(file => file.id === confirmId)!.fileName}
        description="Файл исчезнет из заявки и папки вложений. В истории останется отметка об удалении. Восстановить файл можно только повторной загрузкой."
        confirmLabel="Удалить вложение"
        pendingLabel="Удаляем…"
        error={error}
        busy={!!removingId}
        onClose={close}
        onConfirm={() => void remove(attachments.find(file => file.id === confirmId)!)} />}
    </AnimatedOverlay>}
  </section>
}
