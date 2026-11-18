
export type SitePublication = { key: string; title: string; body?: string; summary?: string; metadata?: { summary?: string }; published_at?: string | Date }
export type PageMetadata = { title: string; description: string; path: string; index: boolean; status: number; type: 'website' | 'article' }
export const siteDescription = 'Staffly — управление персоналом: расписание смен, команда, заявки, документы и события в одном месте.'
export const publicPages: Record<string, { title: string; description: string; key?: string }> = {

  '/': {
    title: 'Staffly — управление персоналом',
    description: siteDescription,
    key: 'home'
  },

  '/contacts': {
    title: 'Контакты',
    description: 'Контакты владельца сервиса Staffly и способы связи.',
    key: 'contacts'
  },

  '/guide': {
    title: 'Справочник',
    description: 'Инструкции Staffly для сотрудников, руководителей и владельцев: смены, заявки, документы и доступ.'
  },

  '/privacy-policy': {
    title: 'Политика обработки персональных данных',
    description: 'Правила обработки и защиты персональных данных в Staffly.',
    key: 'legal:privacy'
  },

  '/personal-data-consent': {
    title: 'Согласие на обработку персональных данных',
    description: 'Условия согласия на обработку персональных данных в Staffly.',
    key: 'legal:consent'
  },

  '/terms': {
    title: 'Пользовательское соглашение',
    description: 'Условия использования сервиса Staffly.',
    key: 'legal:terms'
  },

  '/offer': {
    title: 'Публичная оферта',
    description: 'Условия предоставления сервиса Staffly.',
    key: 'legal:offer'
  },
}
type GuideCatalog = {
  articles: Array<{ slug: string; title: string; summary: string }>
  categories: Array<{ id: string; title: string; description: string }>
  collections: Array<{ id: string; title: string; description: string }>
}

export function pageMetadata(path: string, publications: SitePublication[] = [], catalog?: GuideCatalog): PageMetadata {

  const guideArticles = catalog?.articles ?? []

  const guideCategories = catalog?.categories ?? []

  const guideCollections = catalog?.collections ?? []

  const result: PageMetadata = {
    title: 'Страница не найдена — Staffly',
    description: siteDescription,
    path,
    index: false,
    status: 404,
    type: 'website'
  }

  if (/^\/(app|admin|workspace|auth|verify-email|forgot-password|reset-password)(\/|$)/.test(path)) {

    return {
      ...result,
      title: 'Личный кабинет — Staffly',
      status: 200
    }

  }

  const fixed = publicPages[path]

  const category = path.startsWith('/guide/category/') ? [...guideCollections, ...guideCategories].find(c => path === '/guide/category/' + c.id) : undefined

  const slug = path.startsWith('/guide/') ? path.slice(7) : ''

  const article = guideArticles.find(a => a.slug === slug)

  const published = publications.find(p => p.key === (fixed?.key ?? (slug ? 'guide:' + slug : '')))

  if (!fixed && !category && !article && !published) return result

  const title = published?.title ?? fixed?.title ?? category?.title ?? article!.title

  const description = published?.metadata?.summary || (published ? (published.body ?? published.summary ?? '').replace(/[#*`{}[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : '') || fixed?.description || category?.description || article?.summary || siteDescription

  return {
    ...result,
    title: path === '/' && !published ? title : title + ' — Staffly',
    description,
    index: true,
    status: 200,
    type: article || published?.key.startsWith('guide:') ? 'article' : 'website'
  }
}
export const escapeMarkup = (value: string) => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]!)
export function metadataHead(meta: PageMetadata, origin: string) {

  const canonical = origin + meta.path, image = origin + '/social-card.png'

  const tags = [
    `<title>${escapeMarkup(meta.title)}</title>`,
    `<meta name="description" content="${escapeMarkup(meta.description)}" />`,
    `<meta name="robots" content="${meta.index ? 'index, follow' : 'noindex, nofollow'}" />`,
    `<meta property="og:site_name" content="Staffly" />`,
    ...Object.entries({
      title: meta.title,
      description: meta.description,
      type: meta.type,
      locale: 'ru_RU',
      image,
      'image:width': '1200',
      'image:height': '630',
      'image:alt': 'Staffly — управление персоналом'
    }).map(([key, value]) => `<meta property="og:${key}" content="${escapeMarkup(value)}" />`),
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...Object.entries({
      title: meta.title,
      description: meta.description,
      image
    }).map(([key, value]) => `<meta name="twitter:${key}" content="${escapeMarkup(value)}" />`),
  ]
  // Private URLs can contain identifiers or secrets. Never repeat them in head.

  if (meta.index) tags.push(`<link rel="canonical" href="${escapeMarkup(canonical)}" />`, `<meta property="og:url" content="${escapeMarkup(canonical)}" />`)

  return tags.join('\n')
}

