import { useTimeCorrection } from '../../../../app/schedule/time/time-correction-context.tsx'
import { canCorrectShift } from '../../../../app/schedule/time/time-correction.ts'
import type { WorkShift } from '../../../../app/schedule/types.ts'
import './time-correction.scss'

/** Independent control: never put inside a link/button. Compatible with ActionSurface rows. */
export default function TimeCorrectionAction({ shift, locationId, className = '', icon = false }: { shift: Pick<WorkShift, 'id' | 'status' | 'scheduledStartAt'>; locationId?: string; className?: string; icon?: boolean }) {
  const correction = useTimeCorrection()
  if (!correction?.canOpen(locationId) || !canCorrectShift(shift)) return null
  return <button type="button" className={`time-correction-action ${className}`} onClick={event => { event.stopPropagation(); correction.open(shift.id, locationId) }}>{icon && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 3 3L8 17l-4 3Zm8 0h9" /></svg>}Исправить время</button>
}
