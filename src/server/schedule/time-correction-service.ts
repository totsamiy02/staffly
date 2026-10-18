import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { getMembership } from '../organizations/permissions.ts'
import { requirePermission } from '../organizations/access.ts'
import { locationWhere } from '../organizations/location-context.ts'
import { lockShift } from '../requests/shift-conflicts.ts'
import { publicShift, shiftInclude } from './service.ts'
import { correctionReason, resolveTimeCorrection } from '../../app/schedule/time-correction.ts'

export const timeCorrectionBody = z.object({
  mode: z.enum(['LATE', 'EARLY', 'NO_SHOW', 'CUSTOM', 'RESTORE']),
  startAt: z.iso.datetime().optional(), endAt: z.iso.datetime().optional(),
  comment: z.string().trim().max(400).optional(), expectedUpdatedAt: z.iso.datetime(),
})

export async function getTimeCorrection(userId: string, organizationId: string, shiftId: string) {
  const actor = await getMembership(userId, organizationId)
  requirePermission(actor, 'schedule.actual')
  const shift = await prisma.workShift.findFirst({ where: { id: shiftId, organizationId, ...locationWhere(organizationId) }, include: { ...shiftInclude, location: true } })
  if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
  requirePermission(actor, 'schedule.actual', shift.locationId)
  return { shift: { ...publicShift(shift), updatedAt: shift.updatedAt }, timezone: shift.location.timezone, locationName: shift.location.name }
}

export async function saveTimeCorrection(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof timeCorrectionBody>) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1))::text`
    const actor = await getMembership(userId, organizationId, tx)
    requirePermission(actor, 'schedule.actual')
    await lockShift(tx, shiftId)
    const shift = await tx.workShift.findFirst({ where: { id: shiftId, organizationId, ...locationWhere(organizationId) } })
    if (!shift) throw new ApiError(404, 'SHIFT_NOT_FOUND', 'Смена не найдена.')
    requirePermission(actor, 'schedule.actual', shift.locationId)
    if (shift.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ApiError(409, 'SHIFT_CHANGED', 'Смена уже изменилась. Обновите данные и проверьте корректировку.')
    let result
    try { result = resolveTimeCorrection({ ...shift, scheduledStartAt: shift.scheduledStartAt.toISOString(), scheduledEndAt: shift.scheduledEndAt.toISOString(), actualStartAt: shift.actualStartAt?.toISOString() ?? null, actualEndAt: shift.actualEndAt?.toISOString() ?? null }, input) }
    catch (error) { throw new ApiError(400, 'INVALID_CORRECTION', error instanceof Error ? error.message : 'Проверьте время.') }
    const reason = correctionReason(input)
    const snapshot = (value: typeof shift | typeof result) => ({ attendance: value.attendance, actualStartAt: value.actualStartAt instanceof Date ? value.actualStartAt.toISOString() : value.actualStartAt, actualEndAt: value.actualEndAt instanceof Date ? value.actualEndAt.toISOString() : value.actualEndAt, actualBreakMinutes: value.actualBreakMinutes })
    await tx.workShiftAdjustment.create({ data: {
      shiftId, changedByMemberId: actor.id, kind: 'TIME_CORRECTION', reason,
      previousStartAt: shift.actualStartAt ?? shift.scheduledStartAt, previousEndAt: shift.actualEndAt ?? shift.scheduledEndAt, previousBreakMinutes: shift.actualBreakMinutes ?? shift.breakMinutes,
      newStartAt: result.actualStartAt ?? shift.scheduledStartAt, newEndAt: result.actualEndAt ?? shift.scheduledEndAt, newBreakMinutes: result.actualBreakMinutes ?? shift.breakMinutes,
      assignmentChange: { mode: input.mode, before: snapshot(shift), after: snapshot(result), provisional: result.provisional },
    } })
    const changed = await tx.workShift.update({ where: { id: shiftId }, data: { actualStartAt: result.actualStartAt, actualEndAt: result.actualEndAt, actualBreakMinutes: result.actualBreakMinutes, attendance: result.attendance, attendanceReason: input.mode === 'RESTORE' ? null : reason }, include: shiftInclude })
    return publicShift(changed)
  }, { isolationLevel: 'Serializable' }).catch((error: unknown) => {
    const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } }
    const sqlState = failure.meta?.code ?? failure.meta?.driverAdapterError?.cause?.originalCode
    if (failure.code === 'P2034' || failure.code === 'P2010' && ['40001', '40P01'].includes(sqlState ?? '')) throw new ApiError(409, 'SHIFT_CHANGED', 'Смена уже изменилась. Обновите данные и проверьте корректировку.')
    throw error
  })
}
