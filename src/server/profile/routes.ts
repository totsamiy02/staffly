import { securityHistory } from '../security/history-service.ts'
import { lifecycleStatus, requestAccountDeletion, confirmAccountDeletion } from '../privacy/deletion-service.ts'
import { accountRateLimit } from '../security/rate-limit.ts'
import { updatePresence } from './presence.ts'
import { recordOrganizationPresence } from '../admin/collection.ts'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { requireAuth, clearRefreshCookie, type AuthenticatedRequest } from '../auth.ts'
import { updateProfileBody } from './schemas.ts'
import { bindProfileImage, mediaUrl } from '../storage/image-service.ts'
import { emailPreferencesBody, getEmailPreferences, saveEmailPreferences } from '../mail/email-preferences.ts'

const router = Router()
router.use(requireAuth)
router.use((_request, response, next) => { response.set('Cache-Control', 'private, no-store'); next() })

function auth(request: Request) { return (request as AuthenticatedRequest).auth! }

function profileUser(user: { id: string; email: string; firstName: string | null; lastName: string | null; middleName: string | null; phone: string | null; bio: string | null; lastSeenAt: Date | null; avatarFileId: string | null }) {
  const fullName = [user.lastName, user.firstName].filter(Boolean).join(' ')
  return {
    id: user.id,
    email: user.email,
    displayName: fullName || user.email.split('@')[0],
    firstName: user.firstName,
    lastName: user.lastName,
    middleName: user.middleName,
    phone: user.phone,
    bio: user.bio,
    lastSeenAt: user.lastSeenAt,
    avatarUrl: mediaUrl(user.avatarFileId),
  }
}

const deletionLimiter = accountRateLimit('account-deletion', 10, 900000)
router.get('/profile/security-history', async (request, response) => {
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(request.query)
  response.json(await securityHistory(auth(request).userId, undefined, page))
})
router.get('/profile/data-lifecycle', async (request, response) => { response.json(await lifecycleStatus(auth(request).userId)) })
router.post('/profile/delete/request', deletionLimiter, async (request, response) => {
  z.object({ confirm: z.literal(true) }).strict().parse(request.body)
  response.json(await requestAccountDeletion(auth(request)))
})
router.post('/profile/delete/confirm', deletionLimiter, async (request, response) => {
  const { challengeId, code } = z.object({ confirm: z.literal(true), challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body)
  const result = await confirmAccountDeletion(auth(request), challengeId, code)
  clearRefreshCookie(response)
  response.json(result)
})

router.get('/profile', async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth(request).userId } })
  response.json({ user: profileUser(user) })
})

router.get('/profile/email-preferences', async (request, response) => {
  response.json(await getEmailPreferences(auth(request).userId))
})
router.patch('/profile/email-preferences', async (request, response) => {
  response.json(await saveEmailPreferences(auth(request).userId, emailPreferencesBody.parse(request.body)))
})

router.patch('/profile', async (request, response) => {
  const parsed = updateProfileBody.safeParse(request.body)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные профиля.', z.flattenError(parsed.error).fieldErrors)
  const { avatarUploadId, ...fields } = parsed.data
  const userId = auth(request).userId
  const user = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarFileId: true } })
    const avatarFileId = avatarUploadId === undefined ? current.avatarFileId : await bindProfileImage(tx, userId, current.avatarFileId, avatarUploadId)
    return tx.user.update({ where: { id: userId }, data: { ...fields, avatarFileId } })
  })
  response.json({ user: profileUser(user) })
})

router.post('/profile/presence', async (request, response) => {
  const parsed = z.object({ visible: z.boolean().default(true), organizationId: z.uuid().optional() }).safeParse(request.body)
  if (!parsed.success) throw new ApiError(400, 'INVALID_PRESENCE', 'Некорректное состояние активности.')
  await updatePresence(auth(request).userId, auth(request).sessionId, parsed.data.visible)
  if(parsed.data.visible && parsed.data.organizationId)await recordOrganizationPresence(auth(request).userId,auth(request).sessionId,parsed.data.organizationId)
  response.status(204).end()
})

export default router
