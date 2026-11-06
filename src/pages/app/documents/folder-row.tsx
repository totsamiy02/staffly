import type { Folder } from '../../../app/documents/types.ts'
import DocumentActionsMenu from './document-actions-menu.tsx'
import { DocumentAccess } from './document-row.tsx'

export default function FolderRow({ folder, onOpen, onEdit, onDelete, onPin, pinBusy }: { folder: Folder; onOpen: () => void; onEdit?: () => void; onDelete?: () => void; onPin: () => void; pinBusy: boolean }) {
  return <article className={'document-folder-row' + (folder.systemKey ? ' document-system-folder' : '')}>
    <button type="button" className="document-folder-open" onClick={onOpen}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h7l2 2h9v12H3V6Z" /></svg><span className="document-system-folder__name"><strong>{folder.pinned && !folder.systemKey && <span aria-label="Закреплена">★ </span>}{folder.name}</strong><small>Документов: {folder.documentCount}</small><DocumentAccess visibility={folder.accessVisibility ?? folder.visibility ?? 'ORGANIZATION'} locationId={folder.locationId} locationName={folder.locationName} /></span>{folder.systemKey && <span className="document-system-folder__label">Системная</span>}</button>
    {(!folder.systemKey || onEdit) && <DocumentActionsMenu label={`Действия с папкой ${folder.name}`}>
      {!folder.systemKey && <button disabled={pinBusy} onClick={onPin}>{folder.pinned ? 'Открепить папку' : 'Закрепить папку'}</button>}
      {onEdit && <button onClick={onEdit}>{folder.systemKey ? 'Настроить доступ' : 'Название, точка и доступ'}</button>}
      {!folder.systemKey && onDelete && <button className="document-action-delete" onClick={onDelete}>Удалить папку</button>}
    </DocumentActionsMenu>}
  </article>
}
