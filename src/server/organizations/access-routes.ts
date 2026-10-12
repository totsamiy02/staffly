import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { accessAssignmentBody, accessAudit, accessRoleBody, deleteAccessRole, listAccessRoles, memberAccess, saveAccessRole, saveMemberAccess } from './access-service.ts'
const router = Router(), base = '/organizations/:organizationId'
router.use(base, requireAuth)
const ids = (request: { params: unknown }) => z.object({ organizationId: z.uuid(), roleId: z.uuid().optional(), memberId: z.uuid().optional() }).parse(request.params)
const user = (request: unknown) => (request as AuthenticatedRequest).auth!.userId
router.get(base + '/access/roles', async (q,s) => s.json(await listAccessRoles(user(q),ids(q).organizationId)))
router.post(base + '/access/roles', async (q,s) => s.status(201).json({ role: await saveAccessRole(user(q),ids(q).organizationId,null,accessRoleBody.parse(q.body)) }))
router.put(base + '/access/roles/:roleId', async (q,s) => s.json({ role: await saveAccessRole(user(q),ids(q).organizationId,ids(q).roleId!,accessRoleBody.parse(q.body)) }))
router.delete(base + '/access/roles/:roleId', async (q,s) => { await deleteAccessRole(user(q),ids(q).organizationId,ids(q).roleId!,z.object({ replacementId: z.uuid() }).parse(q.body).replacementId); s.status(204).end() })
router.get(base + '/members/:memberId/access', async (q,s) => s.json(await memberAccess(user(q),ids(q).organizationId,ids(q).memberId!)))
router.put(base + '/members/:memberId/access', async (q,s) => s.json(await saveMemberAccess(user(q),ids(q).organizationId,ids(q).memberId!,accessAssignmentBody.parse(q.body))))
router.get(base + '/access/audit', async (q,s) => s.json({ entries: await accessAudit(user(q),ids(q).organizationId) }))
export default router
