import { definitionOf,processLabel,requestAnswers,requestOutcome } from '../../app/requests/workflow.ts'
import type { OrganizationRequest,RequestType as StoredRequestType } from '../../generated/prisma/client.ts'
import type { RequestMutation,RequestType,StaffRequest } from '../../shared/requests.ts'
import { hasPermission } from '../organizations/access/access.ts'
import { mediaUrl } from '../storage/image-service.ts'
import { dateText,memberName } from './request-input.ts'
import type { RequestActor,RequestViewRow } from './request-model.ts'

const instant = (value: Date | null) => value?.toISOString() ?? null
const absenceReason = (value: string | null | undefined) => value === 'SICK' || value === 'PERSONAL' || value === 'OTHER' ? value : null

// An allowlist keeps new database columns and private relation graphs out of API responses.
export function requestMutation(item: OrganizationRequest): RequestMutation {
  return {
    id: item.id, organizationId: item.organizationId, locationId: item.locationId,
    createdByMemberId: item.createdByMemberId, authorMemberId: item.authorMemberId,
    requestTypeId: item.requestTypeId, typeNameSnapshot: item.typeNameSnapshot,
    systemCodeSnapshot: item.systemCodeSnapshot, status: item.status,
    startDate: dateText(item.startDate), endDate: dateText(item.endDate), comment: item.comment,
    relatedShiftId: item.relatedShiftId, originalStartAt: instant(item.originalStartAt), originalEndAt: instant(item.originalEndAt),
    proposedStartAt: instant(item.proposedStartAt), proposedEndAt: instant(item.proposedEndAt),
    resolvedAt: instant(item.resolvedAt), resolvedByMemberId: item.resolvedByMemberId,
    resolutionComment: item.resolutionComment, cancelledAt: instant(item.cancelledAt),
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
    formSnapshot: definitionOf(item.formSnapshot), answers: requestAnswers.parse(item.answers),
    approvalStep: item.approvalStep, dueAt: instant(item.dueAt),
    outcome: item.outcome === null ? null : requestOutcome.parse(item.outcome),
    staffingRequestId: item.staffingRequestId, staffingPositionId: item.staffingPositionId,
    staffingPositionName: item.staffingPositionName, amendmentOfId: item.amendmentOfId, campaignId: item.campaignId,
  }
}

export function publicRequest(item: RequestViewRow, viewerMemberId: string, actor: RequestActor): StaffRequest {
  const own = item.createdByMemberId === viewerMemberId
  const details = item.systemCodeSnapshot !== 'SICK' || own || item.authorMemberId === viewerMemberId || hasPermission(actor, 'absences.details', item.locationId)
  const contacts = own || hasPermission(actor, 'members.contacts', item.locationId)
  const fields = requestMutation(item)
  const snapshot = definitionOf(item.formSnapshot)
  if (item.requestType) fields.formSnapshot = { ...snapshot,
    dateMode: snapshot.dateMode ?? item.requestType.dateMode,
    requiresComment: snapshot.requiresComment ?? item.requestType.requiresComment,
    allowsAttachments: snapshot.allowsAttachments ?? item.requestType.allowsAttachments }
  return {
    ...fields, isOwn: own, isAuthor: item.authorMemberId === viewerMemberId,
    processLabel: item.absence?.cancelledAt ? 'Отменён' : processLabel({ ...item, startDate: dateText(item.absence?.startDate ?? item.startDate), endDate: dateText(item.absence?.endDate ?? item.endDate) }),
    activeAbsence: item.absence ? { id: item.absence.id, startDate: dateText(item.absence.startDate)!, endDate: dateText(item.absence.endDate)!, cancelledAt: instant(item.absence.cancelledAt), updatedAt: item.absence.updatedAt.toISOString() } : null,
    comment: details ? item.comment : null,
    locationName: item.location.name, timezone: item.location.timezone,
    responseCount: item._count.staffingResponses, absenceReason: details ? absenceReason(item.absence?.reason) : null,
    creatorName: memberName(item.creator.user), creatorRole: item.creator.role,
    creatorRoleName: item.creator.accessAssignments.find(a => a.locationId === item.locationId)?.role.name ?? item.creator.accessRole?.name,
    creatorEmail: contacts ? item.creator.user.email : '', creatorAvatarUrl: mediaUrl(item.creator.user.avatarFileId),
    resolvedByName: item.resolvedBy ? memberName(item.resolvedBy.user) : null,
    firstReadAt: instant(item.reads[0]?.readAt ?? null), readByViewer: item.reads.some(read => read.memberId === viewerMemberId),
    attachments: !own && !hasPermission(actor, 'requests.attachments', item.locationId) ? [] : item.attachments.map(a => ({ id: a.id, fileName: a.fileName, mimeType: a.storedFile.mimeType, size: a.storedFile.size, downloadUrl: `/api/organizations/${item.organizationId}/requests/${item.id}/attachments/${a.id}` })),
    events: item.events.map(event => ({ id: event.id, type: event.type, comment: details ? event.comment : null, changes: details ? event.changes : null, createdAt: event.createdAt.toISOString(), actorMemberId: event.actorMemberId, actorName: memberName(event.actor.user) })),
  }
}

export function publicRequestType(item: StoredRequestType): RequestType {
  return { id: item.id, name: item.name, description: item.description, systemCode: item.systemCode,
    dateMode: item.dateMode, requiresComment: item.requiresComment, allowsAttachments: item.allowsAttachments,
    isActive: item.isActive, version: item.version, definition: definitionOf(item.definition) }
}
