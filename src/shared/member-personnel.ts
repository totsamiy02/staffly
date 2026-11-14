import { z } from 'zod'
import { russianPhone } from './profile-validation.ts'

const name = z.string().trim().min(1, 'Укажите имя и фамилию.').max(80)
  .regex(/^[\p{L}][\p{L}\p{M}' -]*$/u, 'Используйте буквы, пробел, дефис или апостроф.')
const optional = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal(''), z.null()])
  .transform(value => value === '' ? null : value)

export const personnelFields = z.object({
  personnelFirstName: name,
  personnelLastName: name,
  personnelMiddleName: optional(name),
  personnelNumber: optional(z.string().trim().min(1).max(32)
    .regex(/^[\p{L}\p{N}._/-]+$/u, 'В номере допустимы буквы, цифры, точка, дефис, / и _.')),
  workEmail: optional(z.string().trim().toLowerCase().email('Проверьте рабочую почту.').max(254)),
  workPhone: russianPhone,
}).strict()

export const personnelBody = z.discriminatedUnion('mode', [
  personnelFields.extend({ mode: z.literal('personnel'), revision: z.number().int().positive() }).strict(),
  personnelFields.pick({ workEmail: true, workPhone: true })
    .extend({ mode: z.literal('contacts'), revision: z.number().int().positive() }).strict(),
])

export type PersonnelRecord = {
  personnelFirstName: string | null
  personnelLastName: string | null
  personnelMiddleName: string | null
  personnelNumber: string | null
  workEmail: string | null
  workPhone: string | null
  personnelRevision: number
}

export const personnelLabels: Record<keyof Omit<PersonnelRecord, 'personnelRevision'>, string> = {
  personnelLastName: 'Фамилия',
  personnelFirstName: 'Имя',
  personnelMiddleName: 'Отчество',
  personnelNumber: 'Табельный номер',
  workEmail: 'Рабочая почта',
  workPhone: 'Рабочий телефон',
}

export type PersonnelHistory = {
  id: string
  createdAt: string
  actorName: string
  changes: Array<{ field: string; before: string | null; after: string | null }>
}

export type PersonnelData = {
  record: PersonnelRecord | null
  contacts: { workEmail: string | null; workPhone: string | null }
  capabilities: { view: boolean; edit: boolean; contacts: boolean; history: boolean }
  history?: { items: PersonnelHistory[]; page: number; pages: number; total: number }
}
