import { z } from 'zod'
export const fieldKinds = ['TEXT','NUMBER','MONEY','DATE','PERIOD','SELECT','MEMBER','LOCATION','FILE'] as const
export const requestDefinition = z.object({
  dateMode:z.enum(['NONE','SINGLE','RANGE']).optional(),requiresComment:z.boolean().optional(),allowsAttachments:z.boolean().optional(),version:z.number().int().optional(),
  fields: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(2).max(100), kind: z.enum(fieldKinds), required: z.boolean().default(false), options: z.array(z.string().trim().min(1).max(100)).max(50).default([]), when: z.object({ field: z.string(), equals: z.string().max(100) }).optional() })).max(30).default([]),
  submitRoleIds: z.array(z.uuid()).max(100).default([]),
  visibility: z.enum(['REVIEWERS','TEAM']).default('REVIEWERS'),
  stages: z.array(z.object({ name: z.string().trim().min(2).max(100), memberId: z.uuid().optional(), roleId: z.uuid().optional() }).refine(v=>!!v.memberId !== !!v.roleId,'Выберите человека или роль.')).max(10).default([]),
  deadlineDays: z.number().int().min(1).max(365).default(7),
  action: z.enum(['REGISTER','NOTIFY','TASK','DOCUMENT']).default('REGISTER'),
  recipientMemberIds: z.array(z.uuid()).max(100).default([]),
}).superRefine((v,c)=>{const seen=new Set<string>();for(const f of v.fields){if(seen.has(f.key))c.addIssue({code:'custom',message:'Ключи полей должны различаться.'});if(f.when && !seen.has(f.when.field))c.addIssue({code:'custom',message:'Условие должно ссылаться на предыдущее поле.'});if(f.kind==='SELECT'&&!f.options.length)c.addIssue({code:'custom',message:'Добавьте варианты списка.'});seen.add(f.key)}})
export type RequestDefinition = z.infer<typeof requestDefinition>
export type RequestAnswers = Record<string, string | number | { start: string; end: string }>
export const definitionOf = (value: unknown): RequestDefinition => requestDefinition.parse(value ?? {})
export function visibleField(field: RequestDefinition['fields'][number], answers: RequestAnswers) { return !field.when || String(answers[field.when.field] ?? '') === field.when.equals }
const holidays = new Set(['01-01','01-02','01-03','01-04','01-05','01-06','01-07','01-08','02-23','03-08','05-01','05-09','06-12','11-04'])
export function vacationDays(start: string, end: string, extraHolidays: string[] = []) {
  let count=0; const a=Date.parse(start+'T00:00:00Z'), b=Date.parse(end+'T00:00:00Z')
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||b-a>367*86400000)return 0
  for(let day=a;day<=b;day+=86400000){const date=new Date(day).toISOString().slice(0,10);if(!holidays.has(date.slice(5))&&!extraHolidays.includes(date))count++}
  return count
}
export const requestStatusNames = { DRAFT:'Черновик', RETURNED:'На доработке', PENDING:'На рассмотрении', REGISTERED:'Зарегистрировано', APPROVED:'Согласовано', REJECTED:'Отклонено', CANCELLED:'Отменено', EXPIRED:'Срок истёк', INVALID:'Условия изменились' } as const
export function processLabel(item: {status: keyof typeof requestStatusNames; systemCodeSnapshot: string|null; startDate: string|null; endDate: string|null}, today = new Date().toISOString().slice(0,10)) {
  if(item.systemCodeSnapshot==='SICK'&&item.status==='APPROVED')return 'Зарегистрировано'
  if(item.status==='APPROVED'&&item.systemCodeSnapshot==='VACATION')return item.endDate&&item.endDate<today?'Завершён':item.startDate&&item.startDate>today?'Запланирован':'Идёт'
  if(item.systemCodeSnapshot==='STAFFING')return item.status==='PENDING'?'Поиск сотрудника':item.status==='APPROVED'?'Сотрудник назначен':requestStatusNames[item.status]
  return requestStatusNames[item.status]
}
