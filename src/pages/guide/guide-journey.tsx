import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { guideArticles, guideArticleBySlug, guideCollections, guideHref, readingMinutes, guidePlural } from './content/index.ts'
import { guideChapters } from './content/chapters.ts'
import type { GuideArticle } from './content/types.ts'
import Select from '../../component/ui/select/select.tsx'
import GuideArticleContent from './guide-article-content.tsx'
import GuideIcon from './guide-icon.tsx'
import './guide-journey.scss'

type Collection = typeof guideCollections[number]
const articleAnchor = (slug: string) => `article-${slug}`

function moduleArticles(collection: Collection, articles = guideArticles) {
  return guideChapters(collection.id, articles).flatMap(chapter => chapter.slugs.map(slug => guideArticleBySlug.get(slug)!))
}

export function GuideJourney({ collection, activeSlug, continuous = false }: { collection: Collection; activeSlug?: string; continuous?: boolean }) {
  const navigate = useNavigate(), articles = moduleArticles(collection)
  const [open, setOpen] = useState(false)
  const activeLink = useRef<HTMLAnchorElement>(null), graph = useRef<HTMLElement>(null)
  const current = Math.max(0, articles.findIndex(article => article.slug === activeSlug))
  useEffect(() => {
    // Keep the current item visible inside the sticky navigation only.
    const link = activeLink.current, nav = graph.current
    if (!link || !nav) return
    const item = link.getBoundingClientRect(), bounds = nav.getBoundingClientRect()
    if (item.top < bounds.top || item.bottom > bounds.bottom) nav.scrollTo({ top: nav.scrollTop + item.top - bounds.top - nav.clientHeight / 2 + item.height / 2, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [activeSlug])
  return <aside className="guide-journey" aria-label="Навигация по модулю">
    <button className="guide-journey__toggle" type="button" aria-expanded={open} aria-controls="guide-module-navigation" onClick={() => setOpen(!open)}><GuideIcon name="compass" /><span>Содержание модуля</span><span aria-hidden="true">{open ? '−' : '+'}</span></button>
    <div id="guide-module-navigation" className={`guide-journey__body${open ? ' is-open' : ''}`}>
      <label className="guide-journey__module"><span>Модуль справочника</span><Select aria-label="Выбрать модуль справочника" value={collection.id} onChange={event => navigate(`/guide/category/${event.target.value}`)}>{guideCollections.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></label>
      <div className="guide-journey__progress"><span>Содержание</span><small>{String(current + 1).padStart(2, '0')} / {String(articles.length).padStart(2, '0')}</small></div>
      <nav ref={graph} className="guide-journey__graph" aria-label="Разделы модуля">{articles.map((article, index) => <Link ref={activeSlug === article.slug ? activeLink : undefined} key={article.slug} className={`guide-journey__item${index < current ? ' is-read' : ''}`} to={continuous ? `/guide/category/${collection.id}#${articleAnchor(article.slug)}` : guideHref(article.slug)} aria-current={activeSlug === article.slug ? continuous ? 'location' : 'page' : undefined} onClick={() => setOpen(false)}><span className="guide-journey__node">{String(index + 1).padStart(2, '0')}</span><span>{article.title}</span></Link>)}</nav>
      <p className="guide-journey__hint"><GuideIcon name="bulb" />Нажмите на раздел, чтобы перейти к нему.</p>
    </div>
  </aside>
}

export function GuideModule({ collection, articles }: { collection: Collection; articles: GuideArticle[] }) {
  const ordered = useMemo(() => moduleArticles(collection, articles), [collection, articles])
  const [activeSlug, setActiveSlug] = useState(ordered[0]?.slug)
  const [params] = useSearchParams()
  const chapterId = params.get('chapter')
  useEffect(() => {
    // Preserve old chapter bookmarks while presenting all content on one page.
    if (!chapterId || window.location.hash) return
    const first = guideChapters(collection.id).find(chapter => chapter.id === chapterId)?.slugs[0]
    if (first) document.getElementById(articleAnchor(first))?.scrollIntoView({ behavior: 'instant', block: 'start' })
  }, [collection.id, chapterId])
  useEffect(() => {
    const nodes = ordered.map(article => document.getElementById(articleAnchor(article.slug))).filter((node): node is HTMLElement => !!node)
    let frame = 0
    const update = () => {
      frame = 0
      const headerHeight = document.querySelector('.guide-page > header')?.getBoundingClientRect().height ?? 92
      const current = nodes.findLast(node => node.getBoundingClientRect().top <= headerHeight + 64) ?? nodes[0]
      if (current) setActiveSlug(current.id.slice('article-'.length))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    nodes.forEach(node => observer.observe(node))
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule) }
  }, [ordered])
  const next = guideCollections[guideCollections.indexOf(collection) + 1]
  return <div className="guide-module-layout"><GuideJourney collection={collection} activeSlug={activeSlug} continuous /><div className="guide-module-reader">
    <div className="guide-module-meta"><GuideIcon name="book" /><span>{guidePlural(ordered.length, ['раздел', 'раздела', 'разделов'])}</span><span>·</span><GuideIcon name="clock" /><span>{ordered.reduce((minutes, article) => minutes + readingMinutes(article), 0)} мин чтения</span></div>
    {ordered.map((article, index) => <article className="guide-reader-article" tabIndex={-1} id={articleAnchor(article.slug)} key={article.slug} aria-labelledby={`title-${article.slug}`}>
      <header className="guide-reader-heading"><span className="guide-reader-heading__number">{String(index + 1).padStart(2, '0')}</span><div><h2 id={`title-${article.slug}`}>{article.title}</h2><p>{article.summary}</p></div></header>
      <GuideArticleContent article={article} continuous />
    </article>)}
    {next && <Link className="guide-module-next" to={`/guide/category/${next.id}`}><span><small>Следующий модуль</small><strong>{next.title}</strong></span><GuideIcon name="arrow" /></Link>}
  </div></div>
}
