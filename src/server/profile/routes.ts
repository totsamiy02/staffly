import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../db.ts'
import { ApiError } from '../api-error.ts'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { updateProfileBody } from './schemas.ts'
import { mediaUrl } from '../storage/image-service.ts'

const router = Router()
router.use(requireAuth)

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

router.get('/profile', async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth(request).userId } })
  response.json({ user: profileUser(user) })
})

router.patch('/profile', async (request, response) => {
  const parsed = updateProfileBody.safeParse(request.body)
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте данные профиля.', z.flattenError(parsed.error).fieldErrors)
  const user = await prisma.user.update({ where: { id: auth(request).userId }, data: parsed.data })
  response.json({ user: profileUser(user) })
})

router.post('/profile/presence', async (request, response) => {
  const now = new Date()
  await prisma.user.updateMany({
    where: { id: auth(request).userId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: new Date(now.getTime() - 45_000) } }] },
    data: { lastSeenAt: now },
  })
  response.status(204).end()
})

export default router
