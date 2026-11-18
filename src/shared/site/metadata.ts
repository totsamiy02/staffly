import { guideArticles, guideCategories, guideCollections } from '../../pages/guide/content/index.ts'
import { pageMetadata as resolveMetadata, publicPages, type SitePublication } from './metadata-core.ts'

export { metadataHead, escapeMarkup, publicPages, siteDescription } from './metadata-core.ts'
export type { PageMetadata, SitePublication } from './metadata-core.ts'

export function pageMetadata(path: string, publications: SitePublication[] = []) {
  return resolveMetadata(path, publications, {
    articles: guideArticles,
    categories: guideCategories,
    collections: guideCollections,
  })
}

export function sitemapPaths(publications: SitePublication[] = []) {
  return [...new Set([...Object.keys(publicPages), ...guideCollections.map(c => '/guide/category/' + c.id), ...guideCategories.map(c => '/guide/category/' + c.id), ...guideArticles.map(a => '/guide/' + a.slug), ...publications.filter(p => /^guide:[a-z0-9-]+$/.test(p.key)).map(p => '/guide/' + p.key.slice(6))])]
}
