import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { requireAuth, type AuthenticatedRequest } from '../auth.ts'
import { scheduleRangeQuery } from './schemas.ts'
import * as s from './team-planning-schemas.ts'
import * as service from './team-planning-service.ts'
const router=Router(),limit=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false})
router.use(requireAuth)
const base='/organizations/:organizationId/schedule'
const actor=(r:AuthenticatedRequest)=>r.auth!.userId
const org=(r:AuthenticatedRequest)=>z.uuid().parse(r.params.organizationId)
const id=(r:AuthenticatedRequest)=>z.uuid().parse(r.params.draftId)
router.get(base+'/team-settings',async(r,res)=>res.json(await service.getTeamSettings(actor(r),org(r))))
router.put(base+'/team-settings',limit,async(r,res)=>res.json(await service.saveTeamSettings(actor(r),org(r),s.teamSettingsBody.parse(r.body))))
router.get(base+'/demand',async(r,res)=>res.json(await service.getDemand(actor(r),org(r))))
router.post(base+'/demand/versions',limit,async(r,res)=>res.status(201).json(await service.saveDemand(actor(r),org(r),s.demandVersionBody.parse(r.body))))
router.put(base+'/demand/exception',limit,async(r,res)=>res.json(await service.saveDemand(actor(r),org(r),s.demandExceptionBody.parse(r.body))))
router.put(base+'/demand/dates',limit,async(r,res)=>res.json(await service.saveDemandDates(actor(r),org(r),s.demandDatesBody.parse(r.body))))
router.get(base+'/coverage',async(r,res)=>{const q=scheduleRangeQuery.parse(r.query);res.json(await service.getCoverage(actor(r),org(r),q.from,q.to))})
router.get(base+'/drafts',async(r,res)=>res.json(await service.listDrafts(actor(r),org(r))))
router.get(base+'/discussions',async(r,res)=>res.json(await service.listDraftInbox(actor(r),org(r))))
router.post(base+'/drafts',limit,async(r,res)=>res.status(201).json(await service.createDraft(actor(r),org(r),s.draftCreateBody.parse(r.body))))
router.get(base+'/drafts/:draftId',async(r,res)=>res.json(await service.getDraft(actor(r),org(r),id(r))))
router.patch(base+'/drafts/:draftId',limit,async(r,res)=>res.json(await service.editDraft(actor(r),org(r),id(r),s.draftEditBody.parse(r.body))))
router.post(base+'/drafts/:draftId/proposals',limit,async(r,res)=>res.json(await service.changeDraftProposals(actor(r),org(r),id(r),s.draftProposalBody.parse(r.body))))
router.get(base+'/drafts/:draftId/validation',async(r,res)=>res.json(await service.validateDraft(actor(r),org(r),id(r))))
router.post(base+'/drafts/:draftId/action',limit,async(r,res)=>res.json(await service.actOnDraft(actor(r),org(r),id(r),s.draftActionBody.parse(r.body))))
router.post(base+'/drafts/:draftId/response',limit,async(r,res)=>res.json(await service.respondToDraft(actor(r),org(r),id(r),s.draftResponseBody.parse(r.body))))
router.post(base+'/drafts/:draftId/comments',limit,async(r,res)=>res.status(201).json(await service.commentOnDraft(actor(r),org(r),id(r),s.draftCommentBody.parse(r.body))))
router.post(base+'/drafts/:draftId/comments/:commentId',limit,async(r,res)=>res.json(await service.decideDraftComment(actor(r),org(r),id(r),z.uuid().parse(r.params.commentId),s.draftDecisionBody.parse(r.body))))
export default router
