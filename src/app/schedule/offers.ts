import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context.tsx'
import { liveQueryOptions } from '../live-query.ts'
export type OfferMode = 'DISABLED' | 'AUTO' | 'APPROVAL'
export type OfferSettings = { transferMode: OfferMode; swapMode: OfferMode }
export type OfferShift = { id: string; memberId: string; locationId: string; startAt: string; endAt: string; timezone: string; positionId: string | null; positionName: string | null; breakMinutes: number; description: string | null }
export type OfferPerson = { id: string; name: string; avatarUrl: string | null }
export type ShiftOffer = { id: string; kind: 'TRANSFER' | 'SWAP'; mode: OfferMode; status: 'PENDING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'INVALID'; comment: string | null; resolutionReason: string | null; createdAt: string; acceptedAt: string | null; reviewedAt: string | null; closedAt: string | null; location: { id: string; name: string }; source: OfferShift; target: OfferShift | null; initiator: OfferPerson; recipient: OfferPerson | null; acceptedBy: OfferPerson | null; reviewedBy: OfferPerson | null; acceptanceReason?: string | null; canCancel: boolean; canAccept: boolean; canReject: boolean; canApprove: boolean }
export type OfferTab = 'mine' | 'available' | 'sent' | 'approval'
export type OfferList = { offers: ShiftOffer[]; counts: { mine: number; available: number; approval: number }; pagination: { page: number; pages: number; total: number } }
export type OfferCandidate = OfferPerson & { email: string; transferReason: string | null; shifts: Array<OfferShift & { reason: string | null }> }
export const offerStatus: Record<ShiftOffer['status'], string> = { PENDING: 'Ожидает ответа', AWAITING_APPROVAL: 'Ожидает согласования', COMPLETED: 'Завершено', REJECTED: 'Отказано', CANCELLED: 'Отменено', EXPIRED: 'Истекло', INVALID: 'Неактуально' }
export function useOfferSettings(organizationId: string) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-offer-settings', organizationId, locationId], queryFn: () => apiRequest<OfferSettings>(`/organizations/${organizationId}/schedule/offer-settings`) })
}
export function useOffers(organizationId: string, tab: OfferTab = 'mine', page = 1) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-offers', organizationId, locationId, tab, page], queryFn: () => apiRequest<OfferList>(`/organizations/${organizationId}/schedule/offers?tab=${tab}&page=${page}`) })
}
export function useOffer(organizationId: string, id: string | null) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-offer', organizationId, locationId, id], enabled: !!id, queryFn: () => apiRequest<{ offer: ShiftOffer }>(`/organizations/${organizationId}/schedule/offers/${id}`) })
}
export function useOfferCandidates(organizationId: string, shiftId: string) {
  const { apiRequest, locationId } = useAuth()
  return useQuery({ ...liveQueryOptions, queryKey: ['shift-offer-candidates', organizationId, locationId, shiftId], queryFn: () => apiRequest<OfferSettings & { candidates: OfferCandidate[] }>(`/organizations/${organizationId}/schedule/offer-candidates/${shiftId}`) })
}
