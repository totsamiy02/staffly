export type EventAudienceMode = 'ALL' | 'ROLES' | 'SELECTED'
export type EventLocation = { id: string; name: string; timezone: string; archivedAt: string | null }
export type EventRecipient = { id: string; name: string; avatarUrl: string | null; role: 'OWNER' | 'ADMIN' | 'MEMBER' }
export type StaffEvent = {
  id: string; organizationId: string; title: string; description: string | null; typeLabel: string | null;
  startAt: string; endAt: string | null; timezone: string; place: string | null; meetingUrl: string | null;
  shared: boolean; locations: EventLocation[]; audienceMode: EventAudienceMode; audienceRoles: Array<'ADMIN' | 'MEMBER'>;
  recipients: EventRecipient[]; recipientCount: number; isRecipient: boolean;
  createdBy: { id: string; name: string }; updatedBy: { id: string; name: string };
  revision: number; createdAt: string; updatedAt: string; cancelledAt: string | null;
  status: 'CANCELLED' | 'PAST' | 'ONGOING' | 'UPCOMING'; canManage: boolean;
  changes?: Array<{ id: string; action: string; revision: number; createdAt: string; author: string }>;
}
export type EventPage = { events: StaffEvent[]; markedDays: string[]; pagination: { page: number; pageSize: number; total: number; pages: number } }
export type EventFormInput = {
  title: string; description: string; typeLabel: string; startDate: string; startTime: string; endDate: string | null; endTime: string | null;
  place: string; meetingUrl: string; shared: boolean; locationIds: string[]; audienceMode: EventAudienceMode;
  audienceRoles: Array<'ADMIN' | 'MEMBER'>; memberIds: string[]; refreshRecipients: boolean; revision?: number;
}
export type EventMember = EventRecipient & { locationRoles: Array<'ADMIN' | 'MEMBER'> }
export function eventPath(organizationId: string) { return `/organizations/${organizationId}/events` }
export function eventHref(event: Pick<StaffEvent, 'id' | 'organizationId' | 'locations'>, fallback?: string, pointId = 'all') {
  return `/app/organizations/${event.organizationId}/events?${new URLSearchParams({ event: event.id, pointId, ...(event.locations.find(point => !point.archivedAt)?.id || fallback ? { location: event.locations.find(point => !point.archivedAt)?.id ?? fallback! } : {}) })}`
}
