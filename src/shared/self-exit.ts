export type SelfExitPreview = {
  organization: { id: string; name: string; logoUrl: string | null }
  employmentPeriodId: string
  owner: boolean
  locationCount: number
  shifts: number
  tasks: number
  reviews: number
}

export type SelfExitWork = {
  id: string
  memberName: string
  memberAvatarUrl: string | null
  createdAt: string
  shifts: Array<{
    id: string
    locationId: string
    locationName: string
    timezone: string
    startAt: string
    endAt: string
    positionName: string | null
    updatedAt: string
    canAssign: boolean
    canCancel: boolean
  }>
  tasks: Array<{
    id: string
    title: string
    kind: 'TASK' | 'REVIEW'
    locationId: string
    locationName: string
    deadline: string | null
    updatedAt: string
    canAssign: boolean
  }>
}

export type ExitCandidate = {
  id: string
  name: string
  avatarUrl: string | null
  reason: string | null
}
