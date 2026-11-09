import { useLocation } from 'react-router-dom'
import { usePublishedContent,PublishedMarkdown } from '../../../features/public-content/content.tsx'
import type { ReactNode } from 'react'
import './legal-document.scss'

type LegalSection = {
  title: string
  content: ReactNode
  id?: string
}

type LegalDocumentProps = {
  title: string
  updatedAt: string
  sections: LegalSection[]
}

function LegalDocument({ title, updatedAt, sections }: LegalDocumentProps) {
  const {pathname}=useLocation(),key=({'/privacy-policy':'privacy','/terms':'terms','/offer':'offer','/personal-data-consent':'consent'} as Record<string,string>)[pathname]??'privacy',published=usePublishedContent('legal:'+key).item
  return (
    <main className="legal-document">
      <div className="container legal-document__container">
        <a className="legal-document__back" href="/">
          Вернуться на главную
        </a>

        <header className="legal-document__header">
          {!published&&<p className="legal-document__draft">Шаблон — заменить реквизиты перед публикацией</p>}
          <h1>{published?.title??title}</h1>
          <p>{published?'Действует с '+new Date(published.effective_at).toLocaleDateString('ru-RU'): 'Дата последнего обновления: '+updatedAt}</p>
        </header>

        <div className="legal-document__content">
          {published?<PublishedMarkdown>{published.body}</PublishedMarkdown>:sections.map((section, index) => (
            <section id={section.id} key={section.title}>
              <h2>
                {index + 1}. {section.title}
              </h2>
              {section.content}
            </section>
          ))}
        </div>
      </div>
    </main>
  )
}

export default LegalDocument
