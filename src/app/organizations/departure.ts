export type DepartureScope = 'organization' | 'location'
export type DepartureChoice = { shiftId: string; action: 'cancel' | 'reassign'; memberId?: string }
export type DepartureInput = { scope: DepartureScope; token: string; reason: string; choices: DepartureChoice[]; keepCurrent: boolean; acknowledgeDrafts: boolean; acknowledgeWorkload: boolean }
export type DepartureShift = {
  id: string; locationId: string; locationName: string; timezone: string;
  startAt: string; endAt: string; positionName: string | null; minutes: number;
  canCancel: boolean; canReassign: boolean; hasActual: boolean; current: boolean;
}
export type DeparturePreview = {
  token: string; scope: DepartureScope; locationId: string; locationName: string;
  member: { id: string; name: string; avatarUrl: string | null };
  shifts: DepartureShift[]; pendingRequests: number; closingRequests: number; offers: number; acknowledgements: number;
  drafts: Array<{ id: string; title: string; locationId: string; canOpen: boolean }>;
  remainingLocations: string[]; globalAccessRemains: boolean;
  coverage: Array<{ locationId: string; locationName: string; timezone: string; date: string; startAt: string; endAt: string; positionName: string; needed: number; assigned: number; shiftIds: string[] }>;
}
export type DepartureResult = { reassigned: number; cancelled: number; retainedCurrent: number; scope: DepartureScope; locationId: string }
export type DepartureCandidate = { id: string; name: string; reason: string | null }
