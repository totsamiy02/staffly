import { ApiError } from '../api-error.ts'
import { Prisma } from '../../generated/prisma/client.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'
import { locationsFor, hasPermission } from '../organizations/access/access.ts'
import { documentReadSql } from './document-policy.ts'
import { permissionSql, requestReadSql, type Actor } from './request-policy.ts'

export async function notificationPolicy(userId: string, organizationId?: string) {
  const memberships = await prisma.organizationMember.findMany({ where: { userId, leftAt: null, ...(organizationId ? { organizationId } : {}), organization: { deletedAt: null, accountNotifications: { some: { userId, hiddenAt: null } } }, user: { deletedAt: null } }, select: { organizationId: true } })
  const actors = new Map<string, Actor>()
  const roles = await prisma.accessRole.findMany({ where: { organizationId: { in: memberships.map(m => m.organizationId) } }, select: { id: true, organizationId: true, systemCode: true } })
  const policies: Prisma.Sql[] = []
  for (const membership of memberships) {
    let actor: Actor
    try { actor = await getMembership(userId, membership.organizationId) }
    catch (error) { if (error instanceof ApiError && error.status === 404) continue; throw error }
    actors.set(membership.organizationId, actor)
    const permission = (key: Parameters<typeof hasPermission>[1], field: string) => permissionSql(actor,key,Prisma.raw(field))
    const viewIds = locationsFor(actor,'events.view'), managerIds = [...new Set([...locationsFor(actor,'events.edit'), ...locationsFor(actor,'events.cancel')])]
    policies.push(Prisma.sql`(n.organization_id = ${actor.organizationId}::uuid AND CASE
      WHEN n.vacation_campaign_id IS NOT NULL THEN vc.id IS NOT NULL AND ((${actor.id}::uuid = ANY(vc.member_ids) AND ${hasPermission(actor,'requests.own')}) OR ${permission('vacations.collect','vc.location_id')})
      WHEN n.schedule_draft_id IS NOT NULL THEN sd.id IS NOT NULL AND (${permission('drafts.view','sd.location_id')} OR sd.published_at IS NOT NULL AND EXISTS (SELECT 1 FROM draft_recipients dr WHERE dr.draft_id = sd.id AND dr.member_id = ${actor.id}::uuid))
      WHEN n.document_id IS NOT NULL THEN d.id IS NOT NULL AND ${documentReadSql(actor)}
      WHEN n.event_id IS NOT NULL THEN e.id IS NOT NULL AND (${actor.owner} OR
        EXISTS (SELECT 1 FROM event_recipients er WHERE er.event_id = e.id AND er.member_id = ${actor.id}::uuid AND er.removed_at IS NULL) AND
          (e.shared AND ${viewIds.length > 0} OR EXISTS (SELECT 1 FROM event_locations el WHERE el.event_id = e.id AND el.location_id = ANY(${viewIds}::uuid[]))) OR
        EXISTS (SELECT 1 FROM event_locations el WHERE el.event_id = e.id AND el.location_id = ANY(${managerIds}::uuid[])) OR
        e.shared AND ${hasPermission(actor,'events.shared',null) && (hasPermission(actor,'events.edit',null)||hasPermission(actor,'events.cancel',null))})
      WHEN n.shift_offer_id IS NOT NULL THEN so.id IS NOT NULL AND (${actor.id}::uuid IN (so.initiator_member_id,so.recipient_member_id,so.accepted_by_member_id) OR ${permission('offers.approve','so.location_id')} OR so.recipient_member_id IS NULL AND ${permission('offers.accept','so.location_id')})
      WHEN n.absence_id IS NOT NULL THEN a.id IS NOT NULL AND (${actor.owner} OR CASE WHEN a.member_id = ${actor.id}::uuid THEN ${actor.permissions.includes('absences.own')} ELSE
        EXISTS (SELECT 1 FROM location_members alm WHERE alm.member_id = a.member_id AND alm.left_at IS NULL AND ${permission('absences.view','alm.location_id')}) OR
        NOT EXISTS (SELECT 1 FROM location_members alm WHERE alm.member_id = a.member_id AND alm.left_at IS NULL) AND ${hasPermission(actor,'absences.view')} END)
      WHEN n.request_id IS NOT NULL THEN r.id IS NOT NULL AND ${requestReadSql(actor,roles.filter(r => r.organizationId === actor.organizationId))}
      WHEN n.shift_id IS NOT NULL THEN s.id IS NOT NULL AND (CASE WHEN s.member_id = ${actor.id}::uuid THEN ${permission('schedule.own','s.location_id')} ELSE ${permission('schedule.view','s.location_id')} END)
      ELSE TRUE END)`)
  }
  return { actors, sql: policies.length ? Prisma.sql`(${Prisma.join(policies, ' OR ')})` : Prisma.sql`FALSE` }
}

export async function readableNotificationIds(userId: string, organizationId?: string) {
  const { sql } = await notificationPolicy(userId, organizationId)
  return Prisma.sql`SELECT n.id FROM account_notifications n
    JOIN organizations o ON o.id = n.organization_id AND o.deleted_at IS NULL
    LEFT JOIN vacation_campaigns vc ON vc.id = n.vacation_campaign_id AND vc.organization_id = o.id
    LEFT JOIN schedule_drafts sd ON sd.id = n.schedule_draft_id AND sd.organization_id = o.id
    LEFT JOIN documents d ON d.id = n.document_id AND d.organization_id = o.id
    LEFT JOIN organization_events e ON e.id = n.event_id AND e.organization_id = o.id
    LEFT JOIN shift_offers so ON so.id = n.shift_offer_id AND so.organization_id = o.id
    LEFT JOIN employee_absences a ON a.id = n.absence_id AND a.organization_id = o.id
    LEFT JOIN requests r ON r.id = n.request_id AND r.organization_id = o.id
    LEFT JOIN work_shifts s ON s.id = n.shift_id AND s.organization_id = o.id
    WHERE n.user_id = ${userId}::uuid AND n.hidden_at IS NULL AND ${sql}`
}
