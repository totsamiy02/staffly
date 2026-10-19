import type { WorkShift } from '../types.ts'
export type DemandInterval = { positionId: string; startTime: string; endTime: string; endDayOffset: number; needed: number }
export type DemandDay = DemandInterval[] | null
export type DemandWeek = DemandDay[]
export type CoverageSegment = { positionId: string; positionName: string; startAt: string; endAt: string; needed: number; assigned: number; shortage: number; surplus: number }
export type CoverageDay = { date: string; source: 'template' | 'exception' | 'unconfigured'; noDemand: boolean; segments: CoverageSegment[]; shortageIntervals: number; surplusIntervals: number }
export type TeamPlanningSettings = { coverageEnabled: boolean; discussionEnabled: boolean; discussionHours: number }
export type DemandData = { versions: Array<{ id: string; effectiveFrom: string; days: DemandWeek }>; exceptions: Array<{ date: string; intervals: DemandInterval[] }> }
export type DraftStatus = 'PREPARING' | 'OPEN' | 'CLOSED' | 'APPLIED' | 'CANCELLED'
export type DraftProposal = { id: string; sourceShiftId: string | null; kind: 'KEEP' | 'CREATE' | 'UPDATE' | 'CANCEL'; revision: number; source: (WorkShift & { updatedAt: string }) | null; proposed: WorkShift; appliedShiftId: string | null }
export type DraftSummary = { id: string; title: string; description: string | null; fromDate: string; toDate: string; timezone: string; status: DraftStatus; revision: number; deadline: string | null; publishedAt: string | null }
export type DraftComment = { id: string; memberId: string; memberName: string; memberAvatarUrl: string | null; proposalId: string | null; date: string | null; revision: number; text: string; status: 'OPEN' | 'ACCEPTED' | 'REJECTED' | 'RESOLVED' | 'WITHDRAWN'; decision: string | null; createdAt: string; snapshot: unknown }
export type DraftDetail = DraftSummary & {
  proposals: DraftProposal[]; shifts: WorkShift[]; coverage: CoverageDay[]; viewerMemberId: string; canManage: boolean;
  recipients: Array<{ memberId: string; memberName: string; memberAvatarUrl: string | null; active: boolean; requiredRevision: number; respondedRevision: number | null; response: string | null; respondedAt: string | null }>;
  comments: DraftComment[]; history: Array<{ id: string; action: string; revision: number; createdAt: string; actorName: string; details: Record<string, unknown> }>;
  counts: { noObjections: number; objections: number; unanswered: number; participants: number; openComments: number; create: number; update: number; cancel: number; affected: number };
}
export type DraftValidation = { errors: Array<{ code: string; message: string; proposalId?: string }>; warnings: Array<{ code: string; message: string }>; coverage: CoverageDay[] }
