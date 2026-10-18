import type { OrganizationMember } from '../organizations/types.ts'
import type { MemberWorkTime, WorkTimeMember } from '../schedule/types.ts'
import type { DocumentItem } from '../documents/types.ts'
import type { RequestList } from '../requests/types.ts'
export type ProfileSection = 'overview' | 'time' | 'documents' | 'requests'
export type ProfileOptions = { month: string; locationId: string; section: ProfileSection; page: number; kind: 'personal' | 'acknowledgements'; requestState: 'all' | 'pending' }
export type MemberProfileData = {
  member: Omit<OrganizationMember, 'locations'> & { leftAt: string | null; roleName: string | null; locations: Array<{ id: string; name: string; timezone: string }> }
  own: boolean; month: string; location: { id: string; name: string; timezone: string }
  capabilities: { time: boolean; schedule: boolean; documents: boolean; personalDocuments: boolean; acknowledgements: boolean; requests: boolean; absences: boolean; correctTime: boolean; managePositions: boolean; manageAccess: boolean }
  overview?: { period: WorkTimeMember | null; corrections: number | null; upcoming: Array<{ id: string; scheduledStartAt: string; scheduledEndAt: string; positionNameSnapshot: string | null }> | null; nextAbsence: { startDate: string; endDate: string; type: string } | null; pendingDocuments: number | null; pendingRequests: number | null }
  time?: MemberWorkTime
  documents?: { documents: Array<DocumentItem & { profileAcknowledgement: { openedAt: string | null; acknowledgedAt: string | null; deadline: string | null } | null }>; pagination: { page: number; total: number; pages: number } }
  requests?: RequestList
}
