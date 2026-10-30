import type { RequestDefinition, RequestAnswers, requestOutcome } from './request-workflow.ts'
import type { z } from 'zod'

export type RequestSystemCode = 'SICK' | 'VACATION' | 'DAY_OFF' | 'SICK_LEAVE' | 'ABSENCE' | 'SHIFT_CHANGE' | 'SHIFT_PROPOSAL' | 'STAFFING' | 'STAFFING_RESPONSE' | 'OTHER'
export type RequestDateMode = 'NONE' | 'SINGLE' | 'RANGE'
export type RequestStatus = 'DRAFT' | 'RETURNED' | 'REGISTERED' | 'EXPIRED' | 'INVALID' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type RequestOutcome = z.infer<typeof requestOutcome>
export type RequestJson = string | number | boolean | null | RequestJson[] | { [key: string]: RequestJson | undefined }
export type RequestAbsenceType = 'ABSENCE' | 'VACATION' | 'DAY_OFF' | 'SICK' | 'SICK_LEAVE'

export type RequestType = {
  id: string
  name: string
  description: string | null
  systemCode: RequestSystemCode | null
  dateMode: RequestDateMode
  requiresComment: boolean
  allowsAttachments: boolean
  isActive: boolean
  definition?: RequestDefinition
  version?: number
}

// Wire dates are ISO instants or YYYY-MM-DD calendar dates. Internal Date values
// and database relation payloads never cross this boundary.
export type RequestMutation = {
  id: string
  organizationId: string
  locationId: string
  createdByMemberId: string
  authorMemberId: string | null
  requestTypeId: string
  typeNameSnapshot: string
  systemCodeSnapshot: RequestSystemCode | null
  status: RequestStatus
  startDate: string | null
  endDate: string | null
  comment: string | null
  relatedShiftId: string | null
  originalStartAt: string | null
  originalEndAt: string | null
  proposedStartAt: string | null
  proposedEndAt: string | null
  resolvedAt: string | null
  resolvedByMemberId: string | null
  resolutionComment: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  formSnapshot: RequestDefinition
  answers: RequestAnswers
  approvalStep: number
  dueAt: string | null
  outcome: RequestOutcome | null
  staffingRequestId: string | null
  staffingPositionId: string | null
  staffingPositionName: string | null
  amendmentOfId: string | null
  campaignId: string | null
}

export type RequestAttachment = { id: string; fileName: string; mimeType: string; size: number; downloadUrl: string }
export type RequestEvent = {
  id: string
  type: 'EDITED' | 'SUBMITTED' | 'RETURNED' | 'CHANGED' | 'STAGE_APPROVED' | 'EXPIRED' | 'INVALID' | 'CREATED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  comment: string | null
  changes: RequestJson
  createdAt: string
  actorName: string
  actorMemberId: string
}
export type StaffRequest = RequestMutation & {
  canReview?: boolean
  isOwn: boolean
  isAuthor: boolean
  processLabel: string
  activeAbsence: { id: string; startDate: string; endDate: string; cancelledAt: string | null; updatedAt: string } | null
  locationName: string
  timezone: string
  responseCount: number
  absenceReason: 'SICK' | 'PERSONAL' | 'OTHER' | null
  creatorName: string
  creatorRoleName?: string
  creatorRole: 'OWNER' | 'ADMIN' | 'MEMBER'
  creatorEmail: string
  creatorAvatarUrl: string | null
  resolvedByName: string | null
  firstReadAt: string | null
  readByViewer: boolean
  attachments: RequestAttachment[]
  events: RequestEvent[]
}
export type RequestList = {
  requests: StaffRequest[]
  pagination: { page: number; pageSize: number; total: number; pages: number }
  counters: { pending: number; unread: number }
}
export type RequestDetail = {
  staffingResponses: StaffRequest[]
  viewerResponseId: string | null
  viewerCanRespond: boolean
  absenceConflicts: Array<{ id: string; type: RequestAbsenceType; startDate: string; endDate: string }>
  otherAbsentEmployees: number
  request: StaffRequest
  conflicts: Array<{ locationId: string; id: string; scheduledStartAt: string; scheduledEndAt: string }>
}
export type RequestMutationResponse = { request: RequestMutation }
export type RequestTypesResponse = { types: RequestType[] }
export type RequestTypeResponse = { type: RequestType }
