import type { Prisma } from '../../generated/prisma/client.ts'
import type { prisma } from '../db.ts'
import type { getMembership } from '../organizations/access/permissions.ts'
import type { requestInclude } from './request-read.ts'
export type RequestDatabase = Prisma.TransactionClient | typeof prisma
export type RequestActor = Awaited<ReturnType<typeof getMembership>>
export type RequestRow = Prisma.OrganizationRequestGetPayload<{ include: typeof requestInclude }>
export type RequestViewRow = RequestRow & { requestType?: { dateMode: Prisma.RequestTypeGetPayload<object>['dateMode']; requiresComment: boolean; allowsAttachments: boolean } }
