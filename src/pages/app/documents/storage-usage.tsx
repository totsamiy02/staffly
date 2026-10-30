import { sizeLabel } from '../../../app/documents/types.ts'

export default function StorageUsage({ usage, onRequests }: { usage: { usedBytes: number; limitBytes: number; archivedBytes: number; pendingDeletionBytes: number; breakdown?: Record<string, number> }; onRequests: () => void }) {
  const values = usage.breakdown
  const rows = values ? [{ label: 'Документы', bytes: values.documentsBytes }, { label: 'Вложения заявок', bytes: values.requestAttachmentsBytes, onClick: onRequests }, { label: 'Логотип', bytes: values.brandingBytes }, { label: 'Журнал удалений', bytes: values.archivedBytes }, { label: 'Ожидают очистки', bytes: values.pendingBytes }] : []
  const other = Math.max(0, usage.usedBytes - rows.reduce((sum, row) => sum + row.bytes, 0))
  if (values && other) rows.push({ label: 'Прочие файлы', bytes: other })
  return <aside className="document-storage" aria-label="Хранилище организации"><div className="document-storage__heading"><div><strong>Хранилище организации</strong><small>Все файлы организации, включая вложения заявок и логотип.</small></div><span><b>{sizeLabel(usage.usedBytes)}</b> из {sizeLabel(usage.limitBytes)}</span></div><progress value={Math.min(usage.usedBytes, usage.limitBytes)} max={usage.limitBytes} aria-label="Использовано места в хранилище" /><div className="document-storage__breakdown">{rows.filter(row => row.bytes > 0).map(row => <div key={row.label}>{row.onClick ? <button onClick={row.onClick}>{row.label}</button> : <span>{row.label}</span>}<strong>{sizeLabel(row.bytes)}</strong></div>)}</div></aside>
}
