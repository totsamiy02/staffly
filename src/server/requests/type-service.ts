import { Prisma } from '../../generated/prisma/client.ts'

import { requirePermission } from '../organizations/access/access.ts'
import { validateDefinition } from './workflow-validation.ts'

import type { RequestDateMode } from '../../generated/prisma/client.ts'
import { ApiError } from '../api-error.ts'
import { prisma } from '../db.ts'
import { getMembership } from '../organizations/access/permissions.ts'

export const SYSTEM_REQUEST_TYPES = [
  { systemCode: 'SICK', name: 'Сообщить об отсутствии', description: 'Сообщение без согласования. Смены сохраняются, запись остаётся в истории заявок.', dateMode: 'RANGE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'VACATION', name: 'Отпуск', description: 'Плановый период отсутствия', dateMode: 'RANGE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'DAY_OFF', name: 'Отгул', description: 'Отсутствие в течение одного дня', dateMode: 'SINGLE', requiresComment: false, allowsAttachments: true },
  { systemCode: 'ABSENCE', name: 'Освобождение от работы', description: 'Запрос на согласуемое освобождение от работы. Не является сообщением о невыходе или отпуском без оплаты.', dateMode: 'RANGE', requiresComment: true, allowsAttachments: true },
  { systemCode: 'SHIFT_PROPOSAL', name: 'Предложить смену', description: 'Предложение новой смены для себя. Добавляется в расписание после одобрения.', dateMode: 'NONE', requiresComment: true, allowsAttachments: false },
  { systemCode: 'SHIFT_CHANGE', name: 'Изменение смены', description: 'Запрос на изменение назначенной смены', dateMode: 'NONE', requiresComment: true, allowsAttachments: false },
  { systemCode: 'STAFFING', name: 'Нужен сотрудник на подмену', description: 'Открытая смена для сотрудников других точек. Отклик подтверждает принимающая точка.', dateMode: 'NONE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'STAFFING_RESPONSE', name: 'Отклик на подмену', description: 'Отклик сотрудника на открытую смену другой точки.', dateMode: 'NONE', requiresComment: false, allowsAttachments: false },
  { systemCode: 'OTHER', name: 'Другое', description: 'Организационный запрос в свободной форме', dateMode: 'NONE', requiresComment: true, allowsAttachments: true },
] as const

export async function seedSystemRequestTypes(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })
}

export async function ensureSystemTypes(organizationId: string) {
  await prisma.requestType.createMany({ data: SYSTEM_REQUEST_TYPES.map((item) => ({ ...item, organizationId })), skipDuplicates: true })

}

export async function listRequestTypes(userId: string, organizationId: string, includeInactive = false) {
  await getMembership(userId, organizationId)
  await ensureSystemTypes(organizationId)
  const types=await prisma.requestType.findMany({ where: { organizationId, deletedAt: null, OR: [{ systemCode: null }, { systemCode: { not: 'SICK_LEAVE' } }], ...(!includeInactive ? { isActive: true } : {}) }, orderBy: [{ systemCode: 'asc' }, { name: 'asc' }] })
  return types
}

export async function createRequestType(userId: string, organizationId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean; definition?: unknown }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  const definition = await validateDefinition(prisma, organizationId, input.definition)
  return prisma.requestType.create({ data: { definition, organizationId, name: input.name, description: input.description || null, dateMode: input.dateMode, requiresComment: input.requiresComment, allowsAttachments: input.allowsAttachments } })
}

export async function updateRequestType(userId: string, organizationId: string, typeId: string, input: { name: string; description?: string | null; dateMode: RequestDateMode; requiresComment: boolean; allowsAttachments: boolean; isActive: boolean; definition?: unknown }) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  const type = await prisma.requestType.findFirst({ where: { id: typeId, organizationId, deletedAt: null } })
  if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Тип заявки не найден.')

  if (type.systemCode) {
    if (input.name !== type.name || input.description !== type.description || input.dateMode !== type.dateMode || input.requiresComment !== type.requiresComment || input.allowsAttachments !== type.allowsAttachments) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'У системного типа можно менять только доступность.')
    return prisma.requestType.update({ where: { id: type.id }, data: { isActive: input.isActive } })
  }
  return prisma.requestType.update({ where: { id: type.id }, data: { ...input, definition: await validateDefinition(prisma, organizationId, input.definition ?? type.definition), version: {increment:1}, description: input.description || null } })
}

export async function deleteRequestType(userId: string, organizationId: string, typeId: string) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'requestTypes.manage', null)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const type = await tx.requestType.findFirst({ where: { id: typeId, organizationId } })
    if (!type) throw new ApiError(404, 'REQUEST_TYPE_NOT_FOUND', 'Тип заявки не найден.')
    if (type.systemCode) throw new ApiError(409, 'SYSTEM_REQUEST_TYPE', 'Системный тип нельзя удалить. Можно отключить подачу.')
    if (type.deletedAt) return { deleted: true }
    const used = await tx.organizationRequest.count({ where: { organizationId, requestTypeId: typeId } })
    if (used) await tx.requestType.update({ where: { id: typeId }, data: { isActive: false, deletedAt: new Date() } })
    else await tx.requestType.delete({ where: { id: typeId } })
    return { deleted: true }
  })
}
