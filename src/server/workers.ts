import { startRequestMaintenance } from './requests/worker.ts'
import { startEmailNotifications } from './mail/email-worker.ts'
import { startEventNotifications } from './events/worker.ts'
import { startStorageCleanup } from './storage/image-service.ts'
import { startOAuthCleanup } from './auth/yandex-routes.ts'
import { startBackgroundTask } from './background-task.ts'
import { prisma } from './db.ts'
import { startReportExports } from './schedule/reports/export-jobs.ts'

export function startWorkers() {
  const stops = [startStorageCleanup(), startOAuthCleanup(), startRequestMaintenance(), startEventNotifications(), startEmailNotifications(), startReportExports(),
    startBackgroundTask({ name: 'Rate counter cleanup', intervalMs: 60000, run: async () => {
      await prisma.$executeRaw`DELETE FROM api_rate_limits WHERE reset_at < now() - interval '1 hour'`
    } }),
  ]
  return async () => { await Promise.all(stops.map(stop => stop())) }
}
