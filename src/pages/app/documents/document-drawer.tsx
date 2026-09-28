import DocumentActionsMenu from './document-actions-menu.tsx'
import { liveQueryOptions } from '../../../app/live-query.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import type { DocumentItem, Folder, Recipient } from '../../../app/documents/types.ts'
import { documentPath, sizeLabel, stateLabels, visibilityLabels } from '../../../app/documents/types.ts'
import { useDocumentRefresh } from '../../../app/documents/queries.ts'
import DocumentDialog from './document-dialog.tsx'

function FileIcon() {
  return <svg viewBox="0 0 32 40" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 2h14l8 8v28H5V2Z" /><path d="M19 2v9h8M10 20h12M10 26h12" /></svg>
}
function formatDescription(extension: string) {
  if (['xls', 'xlsx', 'csv'].includes(extension)) return { title: extension === 'csv' ? 'Таблица CSV' : 'Файл Excel', hint: 'Скачайте файл, чтобы открыть таблицу на устройстве.' }
  if (['doc', 'docx'].includes(extension)) return { title: 'Файл Word', hint: 'Скачайте файл, чтобы открыть документ на устройстве.' }
  if (['ppt', 'pptx'].includes(extension)) return { title: 'Презентация PowerPoint', hint: 'Скачайте файл, чтобы открыть презентацию на устройстве.' }
  return { title: 'Файл без предпросмотра', hint: 'Скачайте файл, чтобы открыть его на устройстве.' }
}
export default function DocumentDrawer({ organizationId, documentId, manager, onClose, onEdit, onAssign, onDelete, onRevision, folders = [] }: { organizationId: string; documentId: string; manager: boolean; folders?: Folder[]; onRevision?: (item: DocumentItem) => void; onClose: () => void; onEdit?: (item: DocumentItem) => void; onAssign?: (item: DocumentItem) => void; onDelete?: (item: DocumentItem) => void }) {
  const toast = useToast()
  const { apiRequest, previewFile, downloadFile } = useAuth(), refresh = useDocumentRefresh()
  const path = documentPath(organizationId, documentId)
  const doc = useQuery({ ...liveQueryOptions, queryKey: ['document', organizationId, documentId], queryFn: () => apiRequest<{ document: DocumentItem }>(path), retry: false })
  const [preview, setPreview] = useState(''), [text, setText] = useState(''), [previewLoaded, setPreviewLoaded] = useState(false)
  const [error, setError] = useState(''), [fileAction, setFileAction] = useState<'preview' | 'download' | null>(null)
  const [showRecipients, setShowRecipients] = useState(false), [progressPage, setProgressPage] = useState(1), [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const fileBusy = fileAction !== null
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const progress = useQuery({ ...liveQueryOptions, queryKey: ['document-progress', organizationId, documentId, progressPage], queryFn: () => apiRequest<{ recipients: Recipient[]; pagination: { pages: number; total: number } }>(`${path}/progress?page=${progressPage}`), enabled: manager && showRecipients && Boolean(doc.data), retry: false })
  const ack = useMutation({ mutationFn: () => apiRequest(`${path}/acknowledge`, { method: 'POST' }), onSuccess: async () => { await refresh(); toast('Ознакомление подтверждено.') } })
  const cancel = useMutation({ mutationFn: (id: string) => apiRequest(`${path}/acknowledgements/${id}/cancel`, { method: 'POST' }), onSuccess: async () => { setConfirmCancel(null); await refresh() } })
  async function openFile(action: 'preview' | 'download') {
    if (fileBusy) return
    setFileAction(action); setError('')
    try {
      if (action === 'download') await downloadFile(`${path}/content?action=download`, doc.data!.document.fileName, 'POST')
      else {
        const blob = await previewFile(`${path}/content?action=preview`, 'POST')
        if (blob.type.startsWith('text/plain')) setText(await blob.text())
        else setPreview(URL.createObjectURL(blob))
        setPreviewLoaded(true)
      }
      // The successful delivery is committed after streaming finishes.
      if (doc.data?.document.acknowledgement && !doc.data.document.acknowledgement.openedAt && !doc.data.document.acknowledgement.cancelledAt) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const result = await doc.refetch(), current = result.data?.document.acknowledgement
          if (current?.openedAt || current?.cancelledAt || current?.acknowledgedAt) break
          await new Promise(resolve => window.setTimeout(resolve, 150))
        }
      }
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть документ.') }
    finally { setFileAction(null) }
  }
  const item = doc.data?.document, own = item?.acknowledgement
  const extension = item?.fileName.split('.').at(-1)?.toLowerCase() ?? ''
  const description = formatDescription(extension)
  const activeProgress = item?.progress

  if (showRecipients && item && manager) return <DocumentDialog key="recipients" title="Ознакомление сотрудников" onClose={() => setShowRecipients(false)} onEscape={() => setShowRecipients(false)} className="document-recipients-dialog">
    <p className="document-recipients-title">{item.displayName}</p>
    {activeProgress && <div className="document-progress__summary"><span>Ознакомились: {activeProgress.acknowledged} из {activeProgress.total}</span><span>Ожидают: {activeProgress.total - activeProgress.acknowledged}</span></div>}
    {progress.isLoading ? <div className="app-state" role="status"><span className="app-spinner" />Загружаем статусы…</div> : progress.isError ? <div className="app-state" role="alert"><p>Не удалось загрузить статусы.</p><button className="app-secondary" onClick={() => void progress.refetch()}>Повторить</button></div> : !progress.data?.recipients.some(recipient => !recipient.cancelledAt) ? <p>Активных назначений нет.</p> : progress.data.recipients.filter(recipient => !recipient.cancelledAt).map(recipient => <article className="document-recipient" key={recipient.id}>
      <Avatar className="app-avatar document-avatar" url={recipient.member.avatarUrl} name={recipient.member.name} /><div><strong>{recipient.member.name}{recipient.member.former ? ' · бывший сотрудник' : ''}</strong><span>{stateLabels[recipient.state]}</span>{recipient.acknowledgedAt && <small>{new Date(recipient.acknowledgedAt).toLocaleString('ru-RU')}</small>}</div>
      {!recipient.cancelledAt && !recipient.acknowledgedAt && <button className="app-secondary" disabled={cancel.isPending} onClick={() => setConfirmCancel(recipient.id)}>Отменить</button>}
      {confirmCancel === recipient.id && <div className="document-cancel-confirm"><p>Отменить требование? История сохранится.</p><button className="app-primary" disabled={cancel.isPending} onClick={() => cancel.mutate(recipient.id)}>Да, отменить</button><button className="app-secondary" disabled={cancel.isPending} onClick={() => setConfirmCancel(null)}>Назад</button></div>}
    </article>)}
    {cancel.error && <p className="form-inline-error" role="alert">{cancel.error.message}</p>}
    {progress.data && progress.data.pagination.pages > 1 && <div className="document-pagination"><button className="app-secondary" disabled={progressPage === 1} onClick={() => setProgressPage(progressPage - 1)}>Назад</button><span>{progressPage}/{progress.data.pagination.pages}</span><button className="app-secondary" disabled={progressPage === progress.data.pagination.pages} onClick={() => setProgressPage(progressPage + 1)}>Далее</button></div>}
    <footer><button className="app-secondary" onClick={() => setShowRecipients(false)}>Вернуться к документу</button></footer>
  </DocumentDialog>

  return <DocumentDialog key="viewer" viewer title={item?.displayName ?? 'Документ'} onClose={onClose} className={item?.previewable ? 'document-viewer--preview' : 'document-viewer--compact'} headerContent={<header className="document-viewer-header">
    <div className="document-viewer-heading"><span className="document-viewer-file-icon"><FileIcon /></span><div><h2>{item?.displayName ?? 'Документ'}</h2>{item && <p>{extension.toUpperCase()} · {sizeLabel(item.size)}</p>}</div></div>
    <div className="document-viewer-header__actions">{item && <button className="app-primary" disabled={fileBusy} onClick={() => void openFile('download')}>{fileAction === 'download' ? 'Скачиваем…' : 'Скачать'}</button>}
      {manager && item && !item.deletedAt && <DocumentActionsMenu label="Действия с документом">
        {onEdit && <><button onClick={() => onEdit(item)}>Переименовать</button><button onClick={() => onEdit(item)}>Переместить</button><button onClick={() => onEdit(item)}>Изменить доступ</button></>}
        {onRevision && <button onClick={() => onRevision(item)}>Загрузить новую редакцию</button>}
        {onDelete && <button className="document-action-delete" onClick={() => onDelete(item)}>Удалить документ</button>}
      </DocumentActionsMenu>}
      <button className="document-viewer-close" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
    </div>
  </header>}>
    {doc.isLoading ? <div className="app-state document-viewer-state" role="status"><span className="app-spinner" />Загружаем документ…</div> : doc.isError || !item ? <div className="app-state document-viewer-state" role="alert"><p>{doc.error instanceof Error ? doc.error.message : 'Документ недоступен.'}</p><button className="app-secondary" onClick={() => void doc.refetch()}>Повторить</button></div> : <div className="document-viewer-body">
      <section className="document-viewer-main" aria-label="Содержимое документа">
        {fileAction === 'preview' ? <div className="document-viewer-placeholder" role="status"><span className="app-spinner" /><p>Загружаем предпросмотр…</p></div> : !item.previewable ? <div className="document-viewer-placeholder"><span className="document-viewer-placeholder__icon"><FileIcon /></span><h3>{description.title}</h3><p>{description.hint}</p></div> : previewLoaded ? item.mimeType.startsWith('image/') ? <img className="document-preview-image" src={preview} alt={item.displayName} /> : item.mimeType === 'application/pdf' ? <iframe className="document-preview-pdf" src={preview} title={`Предпросмотр: ${item.displayName}`} /> : <pre className="document-preview-text">{text}</pre> : <div className="document-viewer-placeholder"><span className="document-viewer-placeholder__icon"><FileIcon /></span><h3>Просмотр документа</h3><p>Откройте файл, чтобы прочитать его в Staffly.</p><button className="app-secondary" disabled={fileBusy} onClick={() => void openFile('preview')}>Открыть предпросмотр</button></div>}
        {error && <div className="document-viewer-error" role="alert"><p>{error}</p><button className="app-secondary" disabled={fileBusy} onClick={() => void openFile(item.previewable && !previewLoaded ? 'preview' : 'download')}>Повторить</button></div>}
      </section>
      <aside className="document-viewer-sidebar" aria-label="Сведения и управление документом">
        {item.deletedAt && <p className="app-alert">Документ удалён. История сохранена.</p>}
        <section><h3>Сведения</h3><dl className="document-viewer-facts"><dt>Папка</dt><dd>{item.folderId ? folders.find(folder => folder.id === item.folderId)?.name ?? 'В папке организации' : 'Без папки'}</dd><dt>Обновлён</dt><dd><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</time></dd><dt>Загрузил</dt><dd>{item.uploadedBy.name}</dd><dt>Имя файла</dt><dd>{item.fileName}</dd></dl></section>
        <section><h3>Доступ</h3><p className="document-viewer-access"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="4" y="8" width="12" height="9" rx="2" /><path d="M6 8V6a4 4 0 0 1 8 0v2" /></svg>{visibilityLabels[item.visibility]}</p>{item.targetMember && <p className="document-viewer-note">Относится к сотруднику: {item.targetMember.name}{item.targetMember.former ? ' · бывший сотрудник' : ''}</p>}{manager && !item.deletedAt && onEdit && <button className="document-viewer-link" onClick={() => onEdit(item)}>Изменить</button>}</section>
        {manager && <section><h3>Ознакомление</h3>{activeProgress?.total ? <><p className="document-viewer-progress-label">Ознакомились {activeProgress.acknowledged} из {activeProgress.total}</p><progress className="document-viewer-progress-bar" aria-label="Прогресс ознакомления команды" value={activeProgress.acknowledged} max={activeProgress.total} /><button className="document-viewer-link" onClick={() => setShowRecipients(true)}>Посмотреть сотрудников</button></> : <><p className="document-viewer-note">Не назначено</p>{activeProgress?.cancelled ? <button className="document-viewer-link" onClick={() => setShowRecipients(true)}>История назначений</button> : null}</>}{!item.deletedAt && onAssign && <button className="document-viewer-link" onClick={() => onAssign(item)}>{activeProgress?.total ? 'Изменить получателей' : 'Назначить ознакомление'}</button>}</section>}
        {own && <section className="document-viewer-own-ack"><h3>Ваше ознакомление</h3>{own.assignedBy && <p className="document-viewer-note">Назначил {own.assignedBy}</p>}<p>{stateLabels[own.state]}</p>{own.acknowledgedAt && <p className="document-viewer-note">Подтверждено {new Date(own.acknowledgedAt).toLocaleString('ru-RU')}</p>}{own.comment && <p className="document-viewer-note">{own.comment}</p>}{!own.cancelledAt && !own.acknowledgedAt && !item.deletedAt && <><button className="app-primary" disabled={ack.isPending} onClick={() => ack.mutate()}>{ack.isPending ? 'Подтверждаем…' : 'Подтвердить ознакомление'}</button></>}{ack.error && <p className="form-inline-error" role="alert">{ack.error.message}</p>}</section>}
      </aside>
    </div>}
  </DocumentDialog>
}
