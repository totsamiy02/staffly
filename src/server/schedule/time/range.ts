import type { Prisma } from '../../../generated/prisma/client.ts';
import { scopedLocationId } from '../../organizations/location-context.ts';
import { startOfZonedDate } from '../timezone.ts';

/** Statistics use an exclusive end date, attributed to scheduled start in each point's zone. */
export async function statisticsShiftWhere(
  db: Prisma.TransactionClient,
  organizationId: string,
  from?: string,
  to?: string,
): Promise<Prisma.WorkShiftWhereInput> {
  const locationId = scopedLocationId(organizationId);
  if (!from && !to) return { organizationId, ...(locationId ? { locationId } : {}) };
  const points = await db.organizationLocation.findMany({
    where: { organizationId, ...(locationId ? { id: locationId } : {}) },
    select: { id: true, timezone: true },
  });
  return {
    organizationId,
    OR: points.map(point => ({
      locationId: point.id,
      scheduledStartAt: {
        ...(from ? { gte: startOfZonedDate(from, point.timezone) } : {}),
        ...(to ? { lt: startOfZonedDate(to, point.timezone) } : {}),
      },
    })),
  };
}
