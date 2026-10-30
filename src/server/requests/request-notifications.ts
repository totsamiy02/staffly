import type { Prisma } from '../../generated/prisma/client.ts';
import type { RequestDatabase as DB } from './request-model.ts';
import { stageReviewers } from './reviewers.ts';
export async function notifyStage(db:DB,item:Parameters<typeof stageReviewers>[1]&{id:string;typeNameSnapshot:string},recipients?:Awaited<ReturnType<typeof stageReviewers>>){const people=recipients??await stageReviewers(db,item);if(people.length)await publishRequestNotices(db, people.map(p=>({organizationId:item.organizationId,userId:p.userId,requestId:item.id,type:'REQUEST_CREATED',title:'Обращение на рассмотрении',message:item.typeNameSnapshot})))}

export type RequestNotice = Pick<Prisma.AccountNotificationCreateManyInput, 'organizationId' | 'userId' | 'type' | 'title' | 'message'> & Partial<Pick<Prisma.AccountNotificationCreateManyInput, 'requestId' | 'vacationCampaignId' | 'absenceId'>>

export async function publishRequestNotices(db: DB, notices: RequestNotice[]) {
  if (!notices.length) return { count: 0 }
  return db.accountNotification.createMany({ data: notices })
}

export function markRequestNoticesRead(db: DB, where: Prisma.AccountNotificationWhereInput, readAt = new Date()) {
  return db.accountNotification.updateMany({ where, data: { readAt } })
}
