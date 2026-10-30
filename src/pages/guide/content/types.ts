export type GuideCategoryId = 'start' | 'schedule' | 'time' | 'requests' | 'documents' | 'events' | 'team' | 'organization' | 'account'
export type GuideAudience = 'everyone' | 'manager' | 'owner'
export const guideExampleIds = ['schedule', 'transfer', 'offers', 'time', 'documents', 'events', 'reports', 'role-permissions', 'document-access', 'profile-save', 'location-switcher', 'holiday-dates'] as const
export type GuideExampleId = typeof guideExampleIds[number]
export type GuideSection = {
  id: string
  title: string
  paragraphs?: string[]
  items?: string[]
  steps?: { title: string; text: string }[]
  note?: string
  example?: GuideExampleId
  table?: { headings: string[]; rows: string[][] }
}
export type GuideArticle = {
  slug: string
  category: GuideCategoryId
  title: string
  summary: string
  audience: GuideAudience
  updated: string
  keywords: string[]
  sections: GuideSection[]
  questions?: { question: string; answer: string }[]
  related: string[]
  sources: string[]
}
export const section = (id: string, title: string, content: Omit<GuideSection, 'id' | 'title'>): GuideSection => ({ id, title, ...content })
export const steps = (...entries: [string, string][]) => entries.map(([title, text]) => ({ title, text }))
export function article(input: Omit<GuideArticle, 'updated'> & { updated?: string }): GuideArticle {
  return { updated: '2026-10-11', ...input }
}
