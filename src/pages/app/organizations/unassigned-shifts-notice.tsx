import { Link, useLocation } from 'react-router-dom'
import type { WorkShift } from '../../../app/schedule/types.ts'
import './self-exit-work.scss'

export default function UnassignedShiftsNotice({ shifts }: { shifts: WorkShift[] }) {
  const location = useLocation()
  const groups = new Map<string, { name: string; count: number }>()
  for (const shift of shifts) {
    if (shift.status !== 'UNASSIGNED' || !shift.selfExitId) continue
    const group = groups.get(shift.selfExitId)
    if (group) group.count++
    else groups.set(shift.selfExitId, { name: shift.memberName, count: 1 })
  }
  if (!groups.size) return null
  return <section className="unassigned-shifts-notice" aria-label="Смены, требующие замены">
    {[...groups].map(([id, group]) => {
      const params = new URLSearchParams(location.search)
      params.set('selfExit', id)
      return <div key={id}>
        <div>
          <strong>{group.name} покинул организацию</strong>
          <p>Смен без замены в выбранном периоде: {group.count}. Назначьте замену или отмените смены.</p>
        </div>
        <Link className="app-secondary" to={`${location.pathname}?${params}`}>Показать смены</Link>
      </div>
    })}
  </section>
}
