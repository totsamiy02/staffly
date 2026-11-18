import { useQuery } from '@tanstack/react-query'
/* oxlint-disable react/only-export-components -- Public content hook and renderer share the contract. */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { GuideArticle } from '../../pages/guide/content/types.ts'
import './content.scss'
export type PublishedContent = { key: string; kind: string; title: string; body: string; metadata?: { category?: GuideArticle['category']; audience?: GuideArticle['audience']; summary?: string }; revision: number; effective_at: string; published_at: string; summary?: string; matches?: boolean; reading_minutes?: number }
const MarkdownContent = lazy(() => import('./published-markdown.tsx'))
export function usePublishedContent(key: string, enabled = true) {

  const query = useQuery<PublishedContent | null>({
    queryKey: ['public-content', key],
    enabled,
    staleTime: 30000,
    refetchInterval: 60000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/public/content/' + encodeURIComponent(key), {
        signal,
        credentials: 'omit'
      })
      if (!response.ok) throw new Error('Content unavailable')
      const item = await response.json()
      return item && typeof item.body === 'string' ? item : null
    }
  })

  return {
    key,
    item: query.data ?? null,
    loaded: !query.isPending
  }
}
export function usePublishedGuideCatalogState(query = '') {

  const [search, setSearch] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), query ? 300 : 0)
    return () => clearTimeout(timer)
  }, [query])

  return useQuery<PublishedContent[]>({
    queryKey: ['public-guide-catalog', search],
    staleTime: 30000,
    refetchInterval: 60000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/public/content?kind=guide&search=' + encodeURIComponent(search), {
        signal,
        credentials: 'omit'
      })
      if (!response.ok) throw new Error('Content unavailable')
      const value = await response.json()
      return Array.isArray(value.items) ? value.items : []
    }
  })
}
export const usePublishedGuideCatalog = (query = '') => usePublishedGuideCatalogState(query).data ?? []
export function mergeGuideArticles(original: GuideArticle[], published: PublishedContent[], query = '') {

  const map = new Map(original.map(a => [a.slug, a]))
  for (const item of published) {
    const slug = item.key.replace(/^guide:/, ''), base = map.get(slug)
    if (query && item.matches === false) {
      map.delete(slug)
      continue
    }
    map.set(slug, {
      slug,
      category: item.metadata?.category ?? base?.category ?? 'start',
      title: item.title,
      summary: item.metadata?.summary ?? item.summary ?? item.body?.replace(/[#*`]/g, '').slice(0, 180) ?? '',
      audience: item.metadata?.audience ?? base?.audience ?? 'everyone',
      updated: item.effective_at.slice(0, 10),
      publishedReadingMinutes: item.reading_minutes,
      keywords: query ? query.split(/\s+/) : [],
      sections: [],
      related: base?.related ?? [],
      sources: base?.sources ?? []
    })
  }
  return [...map.values()]
}
export function PublishedMarkdown(props: { children: string; anchorPrefix?: string; preservedAnchors?: string[] }) {

  return <Suspense fallback={<p role="status">Загружаем текст…</p>}>
    <MarkdownContent {...props} />
  </Suspense>
}
export function PublicContentSlot({ name, children }: { name: string; children?: ReactNode }) {
  const { item } = usePublishedContent(name), { pathname } = useLocation()
  return item ? <section className="public-content-section">
    {name === 'home' || pathname === '/contacts' ? <h1>
      {item.title}
    </h1> : <h2>
      {item.title}
    </h2>}
    <PublishedMarkdown preservedAnchors={name === 'home' ? ['about', 'benefits', 'pricing'] : name === 'contacts' ? ['contacts'] : []}>
      {item.body}
    </PublishedMarkdown>
  </section> : children ?? null
}
export function PublicServiceNotice() {

  const { pathname } = useLocation(), announcement = usePublishedContent('announcement', !pathname.startsWith('/admin')), [windows, setWindows] = useState<Array<{ id: string; starts_at: string; ends_at: string; announcement: string }>>([])

  useEffect(() => {
    if (pathname.startsWith('/admin')) return
    const controller = new AbortController()
    const read = () => void fetch('/api/public/service-notice', {
      signal: controller.signal,
      credentials: 'omit'
    }).then(r => r.ok ? r.json() : { windows: [] }).then(r => {
      if (!controller.signal.aborted) setWindows(r.windows)
    }).catch(() => { })
    read()
    const timer = setInterval(read, 30000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [pathname])

  if (pathname.startsWith('/admin')) return null

  const active = windows.filter(w => Date.parse(w.ends_at) > Date.now())

  return <>
    {announcement.item && <aside className="public-service-notice" aria-label="Объявление сервиса">
      <strong>
        {announcement.item.title}
      </strong>
      <PublishedMarkdown>
        {announcement.item.body}
      </PublishedMarkdown>
    </aside>}
    {active.map(w => <aside
      key={w.id}
      className="public-service-notice"
      aria-label="Плановое обслуживание">
      <strong>
        {Date.parse(w.starts_at) > Date.now() ? 'Запланировано обслуживание' : 'Идёт обслуживание'}
      </strong>
      <span>
        {w.announcement}
      </span>
      <small>{new Date(w.starts_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} — {new Date(w.ends_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} · МСК</small>
    </aside>)}
  </>
}
