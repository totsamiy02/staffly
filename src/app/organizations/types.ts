export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type OrganizationSummary = { id: string; name: string; description: string | null; timezone: string; contactEmail: string | null; phone: string | null; website: string | null; address: string | null; logoUrl: string | null; role: OrganizationRole; memberCount: number; joinedAt?: string }
export type PendingInvitation = { id: string; organization: { id: string; name: string }; invitedBy: string; expiresAt: string; createdAt: string }
export type OrganizationMember = { id: string; userId: string; email: string; displayName: string; firstName: string | null; lastName: string | null; middleName: string | null; phone: string | null; bio: string | null; avatarUrl: string | null; lastSeenAt: string | null; online: boolean; role: OrganizationRole; joinedAt: string }
export type ActiveOrganizationInvitation = { id: string; type: 'EMAIL' | 'CODE'; invitedEmail: string | null; expiresAt: string; createdAt: string }
export type AccountNotification = { id: string; type: 'ROLE_CHANGED'; title: string; message: string; createdAt: string; organization: { id: string; name: string } }
