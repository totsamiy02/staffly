import { createOrganization, type CreateOrganizationInput } from '../../src/server/organizations/organization-service.ts'
import { prisma } from '../../src/server/db.ts'
import { effectiveSubscription, TRIAL_DAYS } from '../../src/app/subscriptions/plans.ts'

// Explicit synthetic legacy Business fixture; public creation always starts Free.
// Never call the production self-service activation endpoints to seed test access.
export async function createBusinessOrganization(userId: string, input: CreateOrganizationInput) {
  const organization = await createOrganization(userId, { ...input, locations: [], initialPlan: 'FREE' })
  const now = new Date(), until = new Date(+now + TRIAL_DAYS * 86400000)
  const record = await prisma.organizationSubscription.update({ where: { organizationId: organization.id }, data: { plan:'BUSINESS',periodStart:now,periodEnd:until,trialStartedAt:now,trialEndsAt:until } })
  await prisma.$executeRaw`SELECT public.staffly_sync_subscription_storage_limit(${organization.id}::uuid)`
  const locations=[...organization.locations]
  const owner=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:organization.id,userId}}})
  for(const item of input.locations??[]){
    const point=await prisma.organizationLocation.create({data:{organizationId:organization.id,name:item.name,city:item.city,address:item.address,timezone:item.timezone}})
    await prisma.locationMember.create({data:{organizationId:organization.id,locationId:point.id,memberId:owner.id}})
    if(item.teamNames?.length)await prisma.locationTeam.createMany({data:[...new Set(item.teamNames)].map(name=>({organizationId:organization.id,locationId:point.id,name}))})
    locations.push({...point,role:'OWNER' as const})
  }
  return { ...organization, locations, subscription: effectiveSubscription(record) }
}
