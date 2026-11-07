// Type-only imports keep API contracts aligned without shipping server modules.
import type { administrators,securityState,backupsState,alertsState,candidate } from '../../../server/admin/management/read-model.ts'
export type AdministratorsState=Awaited<ReturnType<typeof administrators>>
export type SecurityState=Awaited<ReturnType<typeof securityState>>
export type BackupsState=Awaited<ReturnType<typeof backupsState>>
export type AlertsState=Awaited<ReturnType<typeof alertsState>>
export type Candidate=Awaited<ReturnType<typeof candidate>>
export type { ActionSpec } from '../../../server/admin/management/schemas.ts'
