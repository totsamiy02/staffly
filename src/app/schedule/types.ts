import type { OrganizationRole } from '../organizations/types.ts'

export type WorkShift = {
  id: string
  memberId: string
  memberName: string
  scheduledStartAt: string
  scheduledEndAt: string
  breakMinutes: number
  actualStartAt: string | null
  actualEndAt: string | null
  actualBreakMinutes: number | null
  effectiveMinutes: number
  description: string | null
  status: 'SCHEDULED' | 'CANCELLED'
  cancelledAt: string | null
  cancellationReason: string | null
  adjusted: boolean
}

export type ShiftNotification = { id: string; organization: { id: string; name: string; timezone: string }; scheduledStartAt: string; scheduledEndAt: string; createdAt: string }
export type EmployeeAbsence = { id: string; memberId: string; memberName: string; type: 'VACATION' | 'DAY_OFF' | 'SICK_LEAVE' | 'ABSENCE'; startDate: string; endDate: string }

export type ShiftDetails = WorkShift & {
  adjustments: Array<{
    id: string
    changedByName: string
    previousStartAt: string
    previousEndAt: string
    previousBreakMinutes: number
    newStartAt: string
    newEndAt: string
    newBreakMinutes: number
    reason: string
    createdAt: string
  }>
  adjustmentPagination: { page: number; limit: number; total: number; pages: number }
}

export type WorkTimeMember = {
  memberId: string
  userId: string
  name: string
  role: OrganizationRole
  active: boolean
  joinedAt: string
  leftAt: string | null
  workedMinutes: number
  workedShifts: number
  averageMinutes: number
  plannedMinutes: number
  plannedShifts: number
}

export type WorkTimeStatistics = {
  summary: { workedMinutes: number; workedShifts: number; plannedMinutes: number; plannedShifts: number; employees: number }
  members: WorkTimeMember[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export type MemberWorkTime = {
  member: { id: string; name: string; role: OrganizationRole; active: boolean }
  period: WorkTimeMember | null
  allTime: WorkTimeMember | null
  history: Array<{ id: string; scheduledStartAt: string; scheduledEndAt: string; actualStartAt: string | null; actualEndAt: string | null; status: 'SCHEDULED' | 'CANCELLED'; minutes: number; adjusted: boolean; description: string | null }>
  pagination: { page: number; limit: number; total: number; pages: number }
  timezone: string
}
