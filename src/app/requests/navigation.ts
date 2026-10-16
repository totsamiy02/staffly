import { canAccess } from '../access/catalog.ts'
import type { OrganizationSummary } from '../organizations/types.ts'

export type RequestTab = 'mine' | 'incoming' | 'history' | 'staffing' | 'vacations' | 'offers'
export function requestSections(organization: OrganizationSummary): Array<{ id: RequestTab; label: string }> {
  return [
    ...(canAccess(organization, 'requests.own') ? [{ id: 'mine' as const, label: 'Мои заявки' }] : []),
    ...(canAccess(organization, 'staffing.respond') || canAccess(organization, 'staffing.create') ? [{ id: 'staffing' as const, label: 'Подмены' }] : []),
    ...(canAccess(organization, 'requests.view') ? [{ id: 'incoming' as const, label: 'На рассмотрении' }, { id: 'history' as const, label: 'Архив заявок' }] : []),
    ...(canAccess(organization, 'requests.own') || canAccess(organization, 'vacations.view') ? [{ id: 'vacations' as const, label: 'Отпуска и сбор дат' }] : []),
    ...((['offers.accept', 'offers.approve', 'offers.transfer', 'offers.swap'] as const).some(permission => canAccess(organization, permission)) ? [{ id: 'offers' as const, label: 'Передача и обмен' }] : []),
  ]
}
