import type { Prisma } from '../../generated/prisma/client.ts'

export async function syncSubscriptionStorageLimit(db: Prisma.TransactionClient, organizationId: string) {
  await db.$executeRaw`SELECT public.staffly_sync_subscription_storage_limit(${organizationId}::uuid)`
}
