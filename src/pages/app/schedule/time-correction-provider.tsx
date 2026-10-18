import { lazy, Suspense, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TimeCorrectionContext } from '../../../app/schedule/time-correction-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
const TimeCorrectionDialog = lazy(() => import('./time-correction-dialog.tsx'))

export default function TimeCorrectionProvider({ organization, children }: { organization: OrganizationSummary; children: ReactNode }) {
  const [selected, setSelected] = useState<{ shiftId: string; locationId: string } | null>(null)
  const canOpen = (point = organization.locationId) => !!point && (!!organization.owner || (organization.permissionLocations?.['schedule.actual'] ? organization.permissionLocations['schedule.actual'].includes(point) : point === organization.locationId && !!organization.permissions?.includes('schedule.actual')))
  return <TimeCorrectionContext.Provider value={{ canOpen, open: (shiftId, point = organization.locationId) => { if (point && canOpen(point)) setSelected({ shiftId, locationId: point }) } }}>{children}{selected && createPortal(<Suspense fallback={null}><TimeCorrectionDialog key={`${selected.locationId}:${selected.shiftId}`} organizationId={organization.id} {...selected} onClose={() => setSelected(null)} /></Suspense>, document.body)}</TimeCorrectionContext.Provider>
}
