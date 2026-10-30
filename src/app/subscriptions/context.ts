import { createContext, useContext } from 'react'
import type { PlanFeature, PlanId, SubscriptionSnapshot } from './plans.ts'
export type PlanNotice = { feature?: PlanFeature; kind?: 'members' | 'locations' | 'storage'; requiredPlan?: PlanId | null; message?: string }
export const SubscriptionContext = createContext<{ subscription?: SubscriptionSnapshot; usage?: { members: number; locations: number; storageBytes: number }; available: (feature: PlanFeature) => boolean; request: (notice: PlanNotice) => void; choose: (plan?: PlanId) => void }>({ available: () => false, request: () => undefined, choose: () => undefined })
export const useSubscription = () => useContext(SubscriptionContext)
