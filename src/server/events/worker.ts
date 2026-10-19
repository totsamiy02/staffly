import { deliverEventStarts } from './service.ts'
import { startBackgroundTask } from '../background-task.ts'
export function startEventNotifications() {
  return startBackgroundTask({ name: 'Event start notifications', intervalMs: 30_000, run: () => deliverEventStarts() })
}
