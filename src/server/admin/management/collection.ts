import { databasePool } from '../../db.ts'
import { startBackgroundTask } from '../../background-task.ts'
export const collectAdminAlerts=()=>databasePool.query('SELECT public.platform_reconcile_admin_alerts()').then(()=>{})
export const startAdminAlerts=()=>startBackgroundTask({name:'Admin alerts',intervalMs:15000,run:collectAdminAlerts})
