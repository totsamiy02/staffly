export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type OrganizationSummary = { id: string; name: string; description: string | null; timezone: string; role: OrganizationRole; memberCount: number; joinedAt?: string }
export type PendingInvitation = { id: string; organization: { id: string; name: string }; invitedBy: string; expiresAt: string; createdAt: string }
export type OrganizationMember = { id: string; userId: string; email: string; displayName: string; role: OrganizationRole; joinedAt: string }
export type ActiveOrganizationInvitation = { id: string; type: 'EMAIL' | 'CODE'; invitedEmail: string | null; expiresAt: string; createdAt: string }
