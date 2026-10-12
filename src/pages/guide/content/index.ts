import { startArticles } from './start.ts'
import { scheduleArticles } from './schedule.ts'
import { timeArticles } from './time.ts'
import { requestArticles } from './requests.ts'
import { documentArticles } from './documents.ts'
import { eventArticles } from './events.ts'
import { teamArticles } from './team.ts'
import { organizationArticles } from './organization.ts'
import { accountArticles } from './account.ts'
import { accessArticles } from './access.ts'
import type { GuideArticle } from './types.ts'
export { guideCategories, guideCollections, guideCollectionFor, audienceLabels } from './categories.ts'
export type { GuideArticle, GuideCategoryId, GuideExampleId } from './types.ts'
export const guideArticles: GuideArticle[] = [...startArticles, ...scheduleArticles, ...timeArticles, ...requestArticles, ...documentArticles, ...eventArticles, ...teamArticles, ...organizationArticles, ...accessArticles, ...accountArticles]
export const guideArticleBySlug = new Map(guideArticles.map(item => [item.slug, item]))
export const featuredSlugs = ['welcome', 'first-day']
export const popularSlugs = ['transfer-shift', 'submit-request', 'roles', 'excel-report']
export const guideHref = (slug: string) => `/guide/${slug}`
export function readingMinutes(article: GuideArticle) {
  return Math.max(2, Math.ceil(JSON.stringify(article.sections).split(/\s+/).length / 150))
}
const normalize = (value: string) => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ')
const synonyms: Record<string, string> = { эксель: 'excel', xlsx: 'excel', поменяться: 'обмен', отдать: 'передача', табель: 'бухгалтерия', отпуск: 'отпуск', логин: 'вход', больничный: 'болезнь' }
const tokenize = (query: string) => normalize(query).trim().split(/\s+/).filter(Boolean).map(token => synonyms[token] ?? token)
// A small prefix stem keeps Russian inflections searchable without a service or dependency.
const stem = (token: string) => token.length > 5 ? token.slice(0, -2) : token
export function searchGuide(query: string, articles = guideArticles) {
  const tokens = tokenize(query).map(stem)
  if (!tokens.length) return articles
  return articles.map(item => {
    const title = normalize(item.title + ' ' + item.keywords.join(' '))
    const body = normalize(item.summary + ' ' + JSON.stringify(item.sections) + ' ' + JSON.stringify(item.questions ?? []))
    const matches = tokens.every(token => title.includes(token) || body.includes(token))
    return { item, score: matches ? tokens.reduce((sum, token) => sum + (title.includes(token) ? 3 : 1), 0) : 0 }
  }).filter(result => result.score).sort((a, b) => b.score - a.score).map(result => result.item)
}

export function guidePlural(count: number, forms: [string, string, string]) {
  const mod100 = Math.abs(count) % 100, mod10 = mod100 % 10
  return `${count} ${forms[mod100 >= 11 && mod100 <= 14 ? 2 : mod10 === 1 ? 0 : mod10 >= 2 && mod10 <= 4 ? 1 : 2]}`
}
