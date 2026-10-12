import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import HeaderFrame from '../../component/header/header-frame.tsx'
import { guideArticles, guideArticleBySlug, guideCategories, guideCollections, guideCollectionFor, audienceLabels, guideHref, readingMinutes, searchGuide, guidePlural } from './content/index.ts'
import type { GuideArticle, GuideExampleId } from './content/index.ts'
import GuideExample from './guide-examples.tsx'
import { guideExampleLabels } from './guide-example-labels.ts'
import GuideIcon from './guide-icon.tsx'
import GuideArtwork from './guide-artwork.tsx'
import AnimatedOverlay from '../app/schedule/animated-overlay.tsx'
import DocumentDialog from '../app/documents/document-dialog.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import '../app/app.scss'
import './guide.scss'

function GuideFigure({ example, onZoom }: { example: GuideExampleId; onZoom: (example: GuideExampleId) => void }) {
  return <figure className="guide-figure">
    <div className="guide-figure__frame"><div className="guide-figure__label"><GuideIcon name="window" />В интерфейсе Staffly</div><GuideExample example={example} /><button type="button" onClick={() => onZoom(example)} aria-label={`Увеличить: ${guideExampleLabels[example]}`}><GuideIcon name="zoom" />Увеличить</button></div>
    <figcaption>{guideExampleLabels[example]} · фрагмент интерфейса с вымышленными данными</figcaption>
  </figure>
}

function ArticleRow({ article, number }: { article: GuideArticle; number?: number }) {
  return <Link className="guide-row" to={guideHref(article.slug)}>
    {number !== undefined && <span className="guide-row__number">{String(number).padStart(2, '0')}</span>}
    <span className="guide-row__body"><strong>{article.title}</strong><span>{article.summary}</span><small><GuideIcon name="clock" />{readingMinutes(article)} мин чтения</small></span><GuideIcon name="arrow" />
  </Link>
}

function GuideSearch({ query, onChange }: { query?: string; onChange?: (value: string) => void }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const value = query ?? draft
  function change(value: string) { if (onChange) onChange(value); else setDraft(value) }
  return <form className="guide-search" role="search" onSubmit={event => { event.preventDefault(); navigate(`/guide${value.trim() ? `?q=${encodeURIComponent(value.trim())}` : ''}`) }}>
    <GuideIcon name="search" /><input type="search" aria-label="Поиск по всему справочнику" placeholder="Поиск по всему справочнику" maxLength={200} value={value} onChange={event => change(event.target.value)} />
    {value && <button type="button" onClick={() => change('')} aria-label="Очистить поиск">×</button>}
    {!onChange && <button className="guide-search__submit" type="submit" aria-label="Найти в справочнике"><GuideIcon name="arrow" /></button>}
  </form>
}

function GuideCatalog({ categoryId }: { categoryId?: string }) {
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') ?? '').slice(0, 200)
  const requestedAudience = params.get('audience') ?? 'all'
  const audience = ['all', 'member', 'manager', 'owner'].includes(requestedAudience) ? requestedAudience : 'all'
  const collection = guideCollections.find(item => item.id === categoryId)
  // Old topic addresses remain valid, including contextual links from the app.
  const category = collection ? undefined : guideCategories.find(item => item.id === categoryId)
  const scope = collection?.categories ?? (category ? [category.id] : undefined)
  const eligible = guideArticles.filter(item => (!query.trim() && scope ? scope.includes(item.category) : true) && (audience === 'member' ? item.audience === 'everyone' : audience === 'owner' ? item.audience === 'owner' : audience === 'manager' ? item.audience !== 'everyone' : true))
  const articles = searchGuide(query, eligible)
  const filtering = Boolean(query.trim()) || audience !== 'all'
  function change(key: string, value: string) {
    setParams(current => { const next = new URLSearchParams(current); if (value && value !== 'all') next.set(key, value); else next.delete(key); return next }, { replace: true })
  }
  if (categoryId && !collection && !category) return <GuideNotFound />
  return <>
    {categoryId && <nav className="guide-breadcrumbs" aria-label="Путь страницы"><Link to="/guide"><GuideIcon name="back" />Справочник</Link><span>/</span><span aria-current="page">{collection?.title ?? category?.title}</span></nav>}
    {!categoryId && !filtering ? <header className="guide-hero">
      <div className="guide-hero__copy"><span className="guide-hero__badge"><GuideIcon name="book" />Руководство пользователя</span><h1>Работать проще,<br />когда всё <em>понятно.</em></h1><p>От первой смены до управления командой.<br />Инструкции, примеры и ответы — в одном месте.</p><div className="guide-hero__actions"><Link className="guide-blue-button" to={guideHref('first-day')}>Начать с основ<GuideIcon name="arrow" /></Link><a href="#guide-topics">Выбрать тему<span>↓</span></a></div></div>
      <div className="guide-hero__art"><GuideArtwork /><span><i />Ваш путеводитель по Staffly</span></div>
    </header> : <header className={`guide-intro${categoryId ? ' guide-intro--chapter' : ''}`}>
      <div><p className="guide-kicker">{categoryId ? `Раздел ${String(guideCollections.indexOf(collection ?? guideCollectionFor(category!.id)) + 1).padStart(2, '0')}` : 'Поиск в справочнике'}</p><h1>{collection?.title ?? category?.title ?? 'Найдём нужную инструкцию'}</h1><p>{collection?.description ?? category?.description ?? 'Пошаговые ответы на рабочие вопросы.'}</p></div>
      {categoryId && <span className="guide-intro__icon" aria-hidden="true"><GuideIcon name={collection?.icon ?? category?.icon} /></span>}
    </header>}
    <GuideSearch query={query} onChange={value => change('q', value)} />
    <div className="guide-search-tools">
      {!categoryId && !filtering && <div className="guide-quick-links"><span>Часто ищут</span>{[['transfer-shift', 'Передать смену'], ['submit-request', 'Взять отгул'], ['excel-report', 'Выгрузить отчёт']].map(([slug, label]) => <Link key={slug} to={guideHref(slug)}>{label}</Link>)}</div>}
      <details className="guide-audience" key={categoryId ?? 'catalog'}><summary>{audience === 'all' ? 'Для всех ролей' : audience === 'member' ? 'Сотруднику' : audience === 'manager' ? 'Руководителю' : 'Владельцу'}<span>⌄</span></summary><div aria-label="Для кого инструкции">{[['all', 'Все роли'], ['member', 'Сотруднику'], ['manager', 'Руководителю'], ['owner', 'Владельцу']].map(([key, label]) => <button key={key} type="button" aria-pressed={audience === key} onClick={() => change('audience', key)}>{label}</button>)}</div></details>
    </div>
    {!categoryId && !filtering ? <section className="guide-topics" id="guide-topics"><div className="guide-section-heading"><div><p className="guide-kicker">Содержание справочника</p><h2>Выберите, с чего начать</h2></div><span>5 тем · {guidePlural(guideArticles.length, ['инструкция', 'инструкции', 'инструкций'])}</span></div><div className="guide-collections">{guideCollections.map((item, index) => <Link className={`guide-collection guide-collection--${item.id}`} key={item.id} to={`/guide/category/${item.id}`}>
      <div className="guide-collection__cover" aria-hidden="true"><span className="guide-collection__number">{String(index + 1).padStart(2, '0')}</span><span className="guide-collection__art"><GuideIcon name={item.icon} /></span><span className="guide-collection__orbit" /></div>
      <div className="guide-collection__body"><h3>{item.title}</h3><p>{item.description}</p><div className="guide-collection__bottom"><span>{guidePlural(guideArticles.filter(article => item.categories.includes(article.category)).length, ['инструкция', 'инструкции', 'инструкций'])}</span><span className="guide-collection__open"><GuideIcon name="arrow" /></span></div></div>
    </Link>)}</div></section> : <section className="guide-results"><div className="guide-section-heading"><h2>{query.trim() ? 'Результаты по всему справочнику' : filtering ? 'Подходящие инструкции' : 'Все инструкции'}</h2><span role="status">{guidePlural(articles.length, ['материал', 'материала', 'материалов'])}</span></div>
      {articles.length ? collection && !filtering ? collection.categories.map(id => <div className="guide-topic" key={id}><h3>{guideCategories.find(item => item.id === id)!.title}</h3><div className="guide-article-list">{articles.filter(item => item.category === id).map((item, index) => <ArticleRow key={item.slug} article={item} number={index + 1} />)}</div></div>) : <div className="guide-article-list">{articles.map((item, index) => <ArticleRow key={item.slug} article={item} number={index + 1} />)}</div> : <div className="guide-empty"><GuideIcon name="search" /><h2>Ничего не найдено</h2><p>Попробуйте другое слово или выберите все роли.</p><button className="app-secondary" onClick={() => setParams({})}>Сбросить поиск и фильтры</button></div>}
    </section>}
  </>
}

function GuideNotFound() {
  return <div className="guide-empty"><GuideIcon name="book" /><h1>Такого материала нет</h1><p>Найдите инструкцию в справочнике.</p><Link className="app-primary" to="/guide">К справочнику</Link></div>
}

function GuideArticleView({ article }: { article: GuideArticle }) {
  const [zoom, setZoom] = useState<GuideExampleId | null>(null)
  const toast = useToast()
  const collection = guideCollectionFor(article.category)
  const chapterNumber = guideCollections.indexOf(collection) + 1
  const toc = [...article.sections.map(section => ({ id: section.id, title: section.title })), ...(article.questions?.length ? [{ id: 'questions', title: 'Вопросы и ответы' }] : [])]
  async function copyLink() {
    try { await navigator.clipboard.writeText(window.location.href); toast('Ссылка на инструкцию скопирована.', 'success') }
    catch { toast('Скопируйте адрес страницы из строки браузера.', 'info') }
  }
  return <>
    <nav className="guide-breadcrumbs" aria-label="Путь страницы"><Link to="/guide"><GuideIcon name="back" />Справочник</Link><span>/</span><Link to={`/guide/category/${collection.id}`}>{collection.title}</Link></nav>
    <GuideSearch />
    <div className="guide-reading-layout"><article className="guide-article-body">
      <header className="guide-article-heading"><p className="guide-article-chapter"><span>{String(chapterNumber).padStart(2, '0')}</span>{collection.title}</p><h1>{article.title}</h1><p>{article.summary}</p><div className="guide-article-meta"><span>{audienceLabels[article.audience]}</span><span>{readingMinutes(article)} мин чтения</span><button type="button" onClick={() => void copyLink()}><GuideIcon name="link" />Скопировать ссылку</button></div></header>
      <details className="guide-mobile-toc"><summary>В этой статье</summary><nav aria-label="Содержание статьи на телефоне">{toc.map(item => <a key={item.id} href={`#${item.id}`}>{item.title}</a>)}</nav></details>
      {article.sections.map((section, index) => <section className="guide-article-section" id={section.id} key={section.id}>
        <h2><span className="guide-section-number">{chapterNumber}.{index + 1}</span><a href={`#${section.id}`}>{section.title}</a></h2>
        {section.paragraphs?.map(text => <p key={text}>{text}</p>)}
        {section.items && <ul className="guide-facts">{section.items.map(text => <li key={text}><GuideIcon name="check" /><span>{text}</span></li>)}</ul>}
        {section.steps && <ol className="guide-steps">{section.steps.map((step, index) => <li key={step.title}><span className="guide-step-number">{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>}
        {section.table && <div className="guide-table-scroll" role="region" aria-label={section.title} tabIndex={0}><table><thead><tr>{section.table.headings.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{section.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
        {section.example && <GuideFigure example={section.example} onZoom={setZoom} />}
        {section.note && <aside className="guide-note"><GuideIcon name="bulb" /><div><strong>Полезно знать</strong><p>{section.note}</p></div></aside>}
      </section>)}
      {article.questions?.length ? <section className="guide-article-section" id="questions"><h2>Вопросы и ответы</h2>{article.questions.map(item => <details className="guide-question" key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</section> : null}
      {article.related.length > 0 && <section className="guide-related"><h2>По этой теме</h2><div className="guide-article-list">{article.related.map(slug => guideArticleBySlug.get(slug)).filter((item): item is GuideArticle => Boolean(item)).map((item, index) => <ArticleRow key={item.slug} article={item} number={index + 1} />)}</div></section>}
      <footer className="guide-article-foot"><span>Обновлено {new Date(article.updated + 'T12:00:00').toLocaleDateString('ru-RU')}</span><Link to="/app">Перейти к работе<GuideIcon name="arrow" /></Link></footer>
    </article><nav className="guide-toc" aria-label="Содержание статьи"><div><span className="guide-kicker"><GuideIcon name="book" />В этой статье</span>{toc.map(item => <a key={item.id} href={`#${item.id}`}>{item.title}</a>)}</div></nav></div>
    {zoom && <AnimatedOverlay variant="modal" className="guide-example-overlay" onClose={() => setZoom(null)}>{close => <DocumentDialog title={guideExampleLabels[zoom]} eyebrow="Пример интерфейса" className="guide-example-dialog" onClose={close}><div className="guide-example-stage" role="region" aria-label="Увеличенный пример интерфейса, доступна горизонтальная прокрутка" tabIndex={0}><GuideExample example={zoom} /></div><p>Вымышленные данные. Элементы внутри примера не выполняют действия.</p></DocumentDialog>}</AnimatedOverlay>}
  </>
}

export default function GuidePage() {
  const { slug, categoryId } = useParams()
  const location = useLocation()
  const article = slug ? guideArticleBySlug.get(slug) : undefined
  const activeCollection = article ? guideCollectionFor(article.category) : guideCollections.find(item => item.id === categoryId) ?? (guideCategories.some(item => item.id === categoryId) ? guideCollectionFor(categoryId as GuideArticle['category']) : undefined)
  const home = location.pathname === '/guide' || location.pathname === '/guide/'
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    const oldTitle = document.title
    document.title = `${article?.title ?? activeCollection?.title ?? 'Справочник'} — Staffly`
    return () => { document.title = oldTitle }
  }, [article, activeCollection])
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let anchor = location.hash.slice(1)
      try { anchor = decodeURIComponent(anchor) } catch { /* Keep malformed fragments harmless. */ }
      const target = anchor ? document.getElementById(anchor) : null
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' })
      else { window.scrollTo({ top: 0, behavior: 'instant' }); main.current?.focus({ preventScroll: true }) }
    })
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.hash])
  return <div className="guide-page"><a className="guide-skip" href="#guide-content">К содержимому</a>
    <HeaderFrame><Link className="app-secondary" to="/app">К работе<GuideIcon name="arrow" /></Link></HeaderFrame>
    {!home && <nav className="guide-topic-nav" aria-label="Темы справочника">{guideCollections.map(item => <NavLink key={item.id} className={activeCollection?.id === item.id ? 'is-current' : ''} to={`/guide/category/${item.id}`}>{item.title}</NavLink>)}</nav>}
    <main ref={main} tabIndex={-1} id="guide-content" className={`guide-main${article ? ' guide-main--article' : ''}`} key={location.pathname}>{home || categoryId ? <GuideCatalog categoryId={categoryId} /> : article ? <GuideArticleView key={article.slug} article={article} /> : <GuideNotFound />}</main>
    <footer className="guide-footer"><span>Staffly · Справочник для всех команд</span><span>Примеры вымышлены</span></footer>
  </div>
}
