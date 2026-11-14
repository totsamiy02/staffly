import type { Prisma } from '../../generated/prisma/client.ts'
import type { getMembership } from './access/permissions.ts'
import { hasPermission, locationsFor } from './access/access.ts'

type SearchOptions = { historical?: boolean; points?: string[] }

export function memberSearchWhere(
  actor: Awaited<ReturnType<typeof getMembership>>,
  term: string,
  options: SearchOptions = {},
): Prisma.OrganizationMemberWhereInput {
  const filter = { contains: term, mode: 'insensitive' as const }
  const available = (points: string[]) => points.filter(id => !options.points || options.points.includes(id))
  const contacts = available(locationsFor(actor, 'members.contacts'))
  const personnel = available(locationsFor(actor, 'members.personnel.view'))
  const scope = (points: string[]): Prisma.OrganizationMemberWhereInput => ({
    OR: [
      { role: 'OWNER' },
      { accessRoleId: { not: null } },
      { accessAssignments: { some: { locationId: { in: points } } } },
      { locationMemberships: { some: {
        ...(options.historical ? {} : { leftAt: null }),
        locationId: { in: points },
      } } },
    ],
  })

  return {
    OR: [
      { user: { OR: [{ firstName: filter }, { lastName: filter }, { middleName: filter }] } },
      ...(actor.owner || contacts.length ? [
        { workEmail: filter, ...(actor.owner ? {} : scope(contacts)) },
      ] : []),
      ...(actor.owner || personnel.length ? [{
        AND: [
          { OR: [
            { personnelFirstName: filter },
            { personnelLastName: filter },
            { personnelMiddleName: filter },
            { personnelNumber: filter },
          ] },
          ...(actor.owner ? [] : [scope(personnel.filter(id => hasPermission(actor, 'members.view', id)))]),
        ],
      }] : []),
    ],
  }
}
