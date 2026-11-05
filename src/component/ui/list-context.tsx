import type { OrganizationSummary } from '../../app/organizations/types.ts'
import { useLocations } from '../../app/organizations/queries.ts'
import './work-context.scss'
export default function ListContext({ organization, pointId, scope }: { organization: OrganizationSummary; pointId?: string | null; scope: string }) {
  const points = useLocations(organization.id)
  const all = !pointId || pointId === 'all'
  const name = pointId === 'shared' ? 'Общие документы организации' : all ? 'Все доступные точки' : points.data?.locations.find(point => point.id === pointId)?.name ?? (organization.locationId === pointId ? organization.location?.name : undefined)
  return <div className="list-context" aria-label="Область текущего списка"><span>Область списка</span><strong>{scope}</strong><span aria-hidden="true">·</span><strong>{name ?? 'Выбранная точка недоступна'}</strong></div>
}
