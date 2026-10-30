import { definitionOf } from '../../app/requests/workflow.ts'
import type { prisma } from '../db.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import { hasPermission, locationsFor } from '../organizations/access/access.ts'
import type { getMembership } from '../organizations/access/permissions.ts'
export type Actor = Awaited<ReturnType<typeof getMembership>>
type Role = { id: string; systemCode: string | null }

// Both query forms share the same current role bindings. No archive rows or
// snapshots are fetched to build this policy. The JSON containment predicates
// deliberately match partial stage objects (a stage also carries its name).
function bindings(actor: Actor, roles: Role[]) {
  return { global: [...new Set([...(actor.accessRoleId ? [actor.accessRoleId] : []), ...(!actor.accessConfigured ? roles.filter(r => r.systemCode === actor.role).map(r => r.id) : [])])], local: actor.accessAssignments }
}
export function customRequestWhere(actor: Actor, roles: Role[]): Prisma.OrganizationRequestWhereInput {
  if (actor.owner) return { organizationId: actor.organizationId }
  const bound = bindings(actor, roles)
  const assigned = { outcome: { path: ['assignees'], array_contains: [actor.id] } }
  const stages = (value: object) => ({ formSnapshot: { path: ['stages'], array_contains: [value] } })
  return { organizationId: actor.organizationId, OR: [
    { createdByMemberId: actor.id }, { authorMemberId: actor.id },
    { AND: [assigned, { locationId: { in: locationsFor(actor, 'requests.own') } }] },
    { AND: [
      // SQL NULL/JSON null/missing assignees must not turn NOT into UNKNOWN.
      { OR: [{ outcome: { equals: Prisma.AnyNull } }, { outcome: { path: ['assignees'], equals: Prisma.AnyNull } }, { NOT: assigned }] },
      { locationId: { in: locationsFor(actor, 'requests.view') } },
      { OR: [
        { formSnapshot: { path: ['visibility'], equals: 'TEAM' } },
        { AND: [{ OR: [{ formSnapshot: { equals: Prisma.AnyNull } }, { formSnapshot: { path: ['stages'], equals: Prisma.AnyNull } }, { formSnapshot: { path: ['stages'], equals: [] } }] },
          { OR: [{ locationId: { in: locationsFor(actor, 'requests.resolve') } }, { formSnapshot: { equals: Prisma.AnyNull } }, { formSnapshot: { path: ['version'], equals: Prisma.AnyNull } }] }] },
        stages({ memberId: actor.id }), ...bound.global.map(roleId => stages({ roleId })),
        ...bound.local.map(a => ({ locationId: a.locationId, ...stages({ roleId: a.roleId }) })),
      ] },
    ] },
  ] }
}
export function permissionSql(actor: Actor, key: Parameters<typeof hasPermission>[1], location: Prisma.Sql) {
  if (actor.owner) return Prisma.sql`TRUE`
  return Prisma.sql`(CASE WHEN ${location} IS NULL THEN ${hasPermission(actor, key, null)} ELSE ${location} = ANY(${locationsFor(actor, key)}::uuid[]) END)`
}
export function customRequestSql(actor: Actor, roles: Role[], alias = 'r'): Prisma.Sql {
  // Alias is internal-only; identifiers must never come from request input.
  if (!/^[a-z][a-z_]*$/.test(alias)) throw new Error('Invalid policy alias')
  const r = Prisma.raw(alias), bound = bindings(actor, roles)
  const local = bound.local.map(a => Prisma.sql`(${r}.location_id = ${a.locationId}::uuid AND ${r}.form_snapshot->'stages' @> ${JSON.stringify([{roleId:a.roleId}])}::jsonb)`)
  const global = bound.global.map(roleId => Prisma.sql`${r}.form_snapshot->'stages' @> ${JSON.stringify([{roleId}])}::jsonb`)
  return Prisma.sql`(${r}.organization_id = ${actor.organizationId}::uuid AND (${actor.owner} OR ${r}.created_by_member_id = ${actor.id}::uuid OR ${r}.author_member_id = ${actor.id}::uuid OR
    CASE WHEN COALESCE(${r}.outcome->'assignees' @> ${JSON.stringify([actor.id])}::jsonb, FALSE) THEN ${permissionSql(actor,'requests.own',Prisma.sql`${r}.location_id`)} ELSE
      ${permissionSql(actor,'requests.view',Prisma.sql`${r}.location_id`)} AND (
        ${r}.form_snapshot->>'visibility' = 'TEAM' OR
        (COALESCE(${r}.form_snapshot->'stages', '[]'::jsonb) = '[]'::jsonb AND (${permissionSql(actor,'requests.resolve',Prisma.sql`${r}.location_id`)} OR ${r}.form_snapshot->'version' IS NULL)) OR
        ${r}.form_snapshot->'stages' @> ${JSON.stringify([{memberId:actor.id}])}::jsonb
        ${global.length || local.length ? Prisma.sql`OR ${Prisma.join([...global,...local], ' OR ')}` : Prisma.empty}
      ) END))`
}

export function requestReadSql(actor: Actor, roles: Role[]): Prisma.Sql {
  return Prisma.sql`(r.organization_id = ${actor.organizationId}::uuid
    AND (r.status <> 'DRAFT' OR r.created_by_member_id = ${actor.id}::uuid OR r.author_member_id = ${actor.id}::uuid)
    AND (r.created_by_member_id <> ${actor.id}::uuid OR ${permissionSql(actor,'requests.own',Prisma.sql`r.location_id`)})
    AND CASE WHEN r.system_code_snapshot IS NULL THEN ${customRequestSql(actor,roles)}
      WHEN r.created_by_member_id = ${actor.id}::uuid THEN ${permissionSql(actor,'requests.own',Prisma.sql`r.location_id`)}
      ELSE (${permissionSql(actor,'requests.view',Prisma.sql`r.location_id`)} OR
        r.system_code_snapshot = 'VACATION' AND ${permissionSql(actor,'vacations.view',Prisma.sql`r.location_id`)} OR
        r.system_code_snapshot = 'STAFFING' AND (${permissionSql(actor,'staffing.respond',Prisma.sql`r.location_id`)} OR ${permissionSql(actor,'staffing.create',Prisma.sql`r.location_id`)})) END)`
}

type DB = Prisma.TransactionClient | typeof prisma
export async function canReadCustom(db:DB,actor:Awaited<ReturnType<typeof getMembership>>,item:{createdByMemberId:string;authorMemberId:string|null;locationId:string;formSnapshot:unknown;outcome?:unknown},roles?:Array<{id:string;systemCode:string|null}>){
  if(actor.owner||item.createdByMemberId===actor.id||item.authorMemberId===actor.id)return true
  const outcome=item.outcome as {assignees?:string[]}|null
  if(outcome?.assignees?.includes(actor.id))return hasPermission(actor,'requests.own',item.locationId)
  if(!hasPermission(actor,'requests.view',item.locationId))return false
  const d=definitionOf(item.formSnapshot)
  if(d.visibility==='TEAM')return true
  if(!d.stages.length)return hasPermission(actor,'requests.resolve',item.locationId)||d.version===undefined
  for(const stage of d.stages){if(stage.memberId===actor.id)return true;if(stage.roleId){const role=roles?roles.find(role=>role.id===stage.roleId):await db.accessRole.findFirst({where:{id:stage.roleId,organizationId:actor.organizationId}});if(actor.accessRoleId===stage.roleId||actor.accessAssignments.some(a=>a.locationId===item.locationId&&a.roleId===stage.roleId)||!actor.accessConfigured&&role?.systemCode===actor.role)return true}}
  return false
}
