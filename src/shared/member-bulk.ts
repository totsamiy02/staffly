import { z } from 'zod'

export const memberBulkKind = z.enum(['POSITION', 'LOCATION', 'DOCUMENT'])
export const memberBulkTarget = z.object({ kind: memberBulkKind, targetId: z.uuid() })
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Некорректная дата')
export const memberBulkBody = memberBulkTarget.extend({
  requestKey: z.uuid(),
  rows: z.array(z.object({
    memberId: z.uuid(),
    action: z.enum(['ADD', 'CANCEL']),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(100),
  deadline: calendarDate.nullable().default(null),
  comment: z.string().trim().max(1000).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (new Set(value.rows.map(row => row.memberId)).size !== value.rows.length) {
    context.addIssue({ code: 'custom', message: 'Сотрудник не должен повторяться в списке.' })
  }
  if (value.kind !== 'DOCUMENT' && (value.rows.some(row => row.action === 'CANCEL') || value.deadline || value.comment)) {
    context.addIssue({ code: 'custom', message: 'Для точки и должности доступно только добавление.' })
  }
})

export type MemberBulkTarget = z.infer<typeof memberBulkTarget>
export type MemberBulkInput = z.infer<typeof memberBulkBody>
export type MemberBulkCandidate = {
  id: string
  displayName: string
  avatarUrl: string | null
  secondary: string
  locationIds: string[]
  roleIds: string[]
  status: 'AVAILABLE' | 'ASSIGNED' | 'ACKNOWLEDGED' | 'CANCELLED' | 'BLOCKED'
  reason: string | null
  revision: string
  cancelRevision: string | null
}
export type MemberBulkCandidates = {
  target: MemberBulkTarget & { name: string; locationId: string | null; locationName: string | null }
  members: MemberBulkCandidate[]
  locations: Array<{ id: string; name: string }>
  roles: Array<{ id: string; name: string }>
  truncated: boolean
}
export type MemberBulkResult = {
  rows: Array<{ memberId: string; action: 'ADD' | 'CANCEL'; status: 'APPLIED' | 'UNCHANGED' | 'FAILED'; message: string }>
}
