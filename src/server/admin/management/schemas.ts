import { z } from 'zod'
import { serviceActions } from '../service/schemas.ts'
import { periodFields } from '../period.ts'
const version=z.number().int().nonnegative().max(2147483647)
const empty=z.object({}).strict()
export const actionSpec=z.discriminatedUnion('action',[
 ...serviceActions,
 z.object({action:z.literal('ACCESS_GRANT'),targetId:z.uuid(),payload:z.object({version,userVersion:version}).strict()}).strict(),
 z.object({action:z.literal('ACCESS_REVOKE'),targetId:z.uuid(),payload:z.object({version,userVersion:version}).strict()}).strict(),
 z.object({action:z.literal('SESSION_REVOKE'),targetId:z.uuid(),payload:z.object({version}).strict()}).strict(),
 z.object({action:z.literal('BACKUP_CREATE'),payload:empty}).strict(),
 z.object({action:z.literal('ALERT_RULE'),targetId:z.uuid(),payload:z.object({version,enabled:z.boolean(),threshold:z.number().int().min(1).max(1000)}).strict()}).strict(),
])
export type ActionSpec=z.infer<typeof actionSpec>
export const queryBase=z.object({search:z.string().trim().max(120).default(''),page:z.coerce.number().int().min(1).max(10000).default(1),days:z.coerce.number().int().refine(value=>[0,1,7,30].includes(value)).default(30),...periodFields})
export const pageSize=20
export const iso=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null
