import { useAdminData } from '../admin-data.tsx'
import { AdminBadge } from '../admin-elements.tsx'
import { ReadError } from '../admin-feedback.tsx'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'
import type { BackupJob } from './contracts.ts'

export default function BackupJobFeedback({ id }: { id: string }) {
  const { data, readState } = useAdminData<BackupJob>('/management/backups/jobs/' + id)
  const text = !data ? 'Создание копии запрошено. Получаем состояние задания…' : data.status === 'SUCCEEDED' ? data.kind === 'CREATE' ? 'Копия готова.' : 'Проверка целостности завершена.' : data.status === 'FAILED' ? `Ошибка: ${data.error ?? 'Не удалось выполнить задание.'}` : data.status === 'RUNNING' ? data.kind === 'CREATE' ? 'Создание копии выполняется.' : 'Проверка выполняется.' : 'Задание поставлено в очередь. Ожидаем обработчика.'
  return <div className="admin-notice admin-backup-progress" role="status"><AdminBadge tone={data?.status === 'SUCCEEDED' ? 'green' : data?.status === 'FAILED' ? 'amber' : 'gray'}>{text}</AdminBadge><SupportReference value={id} label="ID задания" />{data?.backupId && <SupportReference value={data.backupId} label="ID копии" />}<ReadError state={readState} /></div>
}
