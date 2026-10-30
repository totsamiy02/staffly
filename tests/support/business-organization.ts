import { createOrganization, type CreateOrganizationInput } from '../../src/server/organizations/organization-service.ts'

// Business workflows choose their trial explicitly. Tests of default/Free
// behavior use the production createOrganization directly.
export function createBusinessOrganization(userId: string, input: CreateOrganizationInput) {
  return createOrganization(userId, { ...input, initialPlan: 'TRIAL' })
}
