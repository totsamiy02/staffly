import { definitionOf } from '../../app/requests/workflow.ts'
import { ApiError } from '../api-error.ts'
import { hasPermission,loadPermissionMembers } from '../organizations/access/access.ts'
import type { RequestDatabase as DB } from './request-model.ts'
export type ReviewerItem = { organizationId: string; locationId: string; createdByMemberId: string; formSnapshot: unknown; approvalStep: number; systemCodeSnapshot: string | null }
export type ReviewerContext = Awaited<ReturnType<typeof loadPermissionMembers>>
export { loadPermissionMembers as loadReviewerContext }
// A context belongs to one operation/transaction, never a cross-request cache.
export function reviewersFromContext(context: ReviewerContext, item: ReviewerItem) {
  if (context.organizationId !== item.organizationId) throw new Error('Reviewer context belongs to another organization')
  const stage = definitionOf(item.formSnapshot).stages[item.approvalStep]
  const key = item.systemCodeSnapshot === 'VACATION' ? 'vacations.resolve' : 'requests.resolve'
  const stageRole = stage?.roleId ? context.roles.find(role => role.id === stage.roleId) : undefined
  return context.members.filter(member => {
    if (!member.permissionLocations[key]?.includes(item.locationId)) return false
    if (member.id === item.createdByMemberId && !hasPermission(member, 'requests.selfResolve', item.locationId)) return false
    if (stage?.memberId && stage.memberId !== member.id) return false
    if (stage?.roleId && (member.accessRoleId !== stage.roleId &&
      !member.accessAssignments.some(a => a.locationId === item.locationId && a.roleId === stage.roleId) &&
      !(!member.accessConfigured && stageRole?.systemCode && member.locationMemberships.some(l => l.locationId === item.locationId && l.role === stageRole.systemCode)))) return false
    return true
  }).map(member => ({ id: member.id, userId: member.userId }))
}
export async function stageReviewers(db: DB, item: ReviewerItem) {
  return reviewersFromContext(await loadPermissionMembers(db, item.organizationId), item)
}
export function requireReviewers(people: ReturnType<typeof reviewersFromContext>) {
  if (!people.length) throw new ApiError(409,'NO_REVIEWER','Нет доступного согласующего. Владелец должен проверить маршрут и права роли.')
  return people
}
export async function ensureReviewers(db: DB, item: ReviewerItem) { return requireReviewers(await stageReviewers(db,item)) }
