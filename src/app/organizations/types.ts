export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type OrganizationSummary = { id: string; name: string; description: string | null; timezone: string; contactEmail: string | null; phone: string | null; website: string | null; address: string | null; logoUrl: string | null; role: OrganizationRole; memberCount: number; joinedAt?: string }
export type PendingInvitation = { id: string; organization: { id: string; name: string; logoUrl: string | null }; readAt: string | null; invitedBy: string; expiresAt: string; createdAt: string }
export type OrganizationMember = { positions?: Array<{ id: string; name: string }>; id: string; userId: string; email: string; displayName: string; firstName: string | null; lastName: string | null; middleName: string | null; phone: string | null; bio: string | null; avatarUrl: string | null; lastSeenAt: string | null; online: boolean; role: OrganizationRole; joinedAt: string }
export type MemberPagination = { page: number; pageSize: number; total: number; pages: number }
export type ActiveOrganizationInvitation = { code: string | null; id: string; type: 'EMAIL' | 'CODE'; invitedEmail: string | null; expiresAt: string; createdAt: string }
export type AccountNotification = { id: string; type: 'ABSENCE_REPORTED' | 'ABSENCE_CHANGED' | 'ABSENCE_CANCELLED' | 'ROLE_CHANGED' | 'REQUEST_CREATED' | 'REQUEST_APPROVED' | 'REQUEST_REJECTED' | 'REQUEST_CANCELLED'; requestId: string | null; title: string; message: string; createdAt: string; organization: { id: string; name: string; logoUrl: string | null } }

export type HistoryNotification = {
  actionable?: boolean
  documentId?: string | null
  id: string
  source: 'event' | 'invite'
  type: string
  title: string
  message: string
  createdAt: string
  readAt: string | null
  state: string | null
  expiresAt: string | null
  inviter: string | null
  organization: { id: string; name: string; logoUrl: string | null }
  href: string | null
}
export type NotificationPage = { notifications: HistoryNotification[]; nextCursor: string | null; unreadCount: number; actionableCount?: number; pendingCount?: number }
