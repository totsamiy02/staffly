import { z } from 'zod'
import { openingHoursSchema } from '../../shared/organization-profile.ts'
import { russianPhone } from '../profile/schemas.ts'
import { RUSSIAN_TIMEZONE_VALUES } from '../../app/organizations/russian-timezones.ts'

export const uuid = z.string().uuid()
export const normalizedEmail = z.string().trim().toLowerCase().email().max(254)

export const organizationIdParams = z.object({ organizationId: uuid })
export const memberParams = organizationIdParams.extend({ memberId: uuid })
export const memberListQuery = z.object({
  directory: z.enum(['true', 'false']).optional(),
  pointId: uuid.optional(),
  positionId: z.union([uuid, z.literal("unassigned")]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
  accessRoleId:uuid.optional(),
  search: z.string().trim().max(100).optional(),
})
export const inviteParams = z.object({ inviteId: uuid })
const optionalText = (max:number) => z.string().trim().max(max).nullable().optional().transform(v=>v||null)
const contacts = {
  contactEmail: z.union([normalizedEmail,z.literal(''),z.null()]).optional().transform(v=>v||null),
  phone: russianPhone.optional().transform(v=>v||null),
  website: z.union([z.string().trim().url().refine(v=>/^https?:\/\//.test(v),'Сайт должен начинаться с http:// или https://'),z.literal(''),z.null()]).optional().transform(v=>v||null),
  address:optionalText(300),
}
export const locationBody = z.object({
 name:z.string().trim().min(2).max(120), city:z.string().trim().max(120).default(''),address:z.string().trim().max(300).default(''),
 timezone:z.enum(RUSSIAN_TIMEZONE_VALUES), kind:z.enum(['PHYSICAL','REMOTE']).default('PHYSICAL'),
 phone:russianPhone.optional().transform(v=>v||null),description:optionalText(1000),
 openingHours:openingHoursSchema.nullable().optional(),inheritsTimezone:z.boolean().optional(),revision:z.number().int().positive().optional(),
 teamNames:z.array(z.string().trim().max(120)).max(50).optional().transform(values=>[...new Set((values??[]).filter(Boolean))]),
}).superRefine((v,ctx)=>{if(v.kind==='PHYSICAL'){if(!v.city)ctx.addIssue({code:'custom',path:['city'],message:'Укажите город.'});if(v.address.length<3)ctx.addIssue({code:'custom',path:['address'],message:'Укажите адрес точки.'})}}).transform(v=>v.kind==='REMOTE'?{...v,city:'',address:''}:v)
const profile = {
 name:z.string().trim().min(2).max(120),description:optionalText(1000),industry:optionalText(120).optional(),
 timezone:z.enum(RUSSIAN_TIMEZONE_VALUES,{error:'Выберите российский часовой пояс.'}),...contacts,
 logoUploadId:z.uuid().nullable().optional(),
}
export const createOrganizationBody = z.object({ ...profile, initialPlan:z.enum(['FREE','TRIAL']).optional(),creationKey:z.uuid().optional(),firstLocation:locationBody,locations:z.array(locationBody).max(49).optional() })
export const updateOrganizationBody = z.object({...profile,profileRevision:z.number().int().positive().optional()})
export const emailInvitationBody = z.object({ email: normalizedEmail })
export const roleBody = z.object({ role: z.enum(['ADMIN', 'MEMBER']) })
export const inviteCodeBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/) })
export const ownershipRequestBody = z.object({ targetMemberId: uuid })
export const sensitiveCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) })
