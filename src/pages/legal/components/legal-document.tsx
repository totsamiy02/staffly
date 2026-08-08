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
  return (
    <main className="legal-document">
      <div className="container legal-document__container">
        <a className="legal-document__back" href="/">
          ← Вернуться на главную
        </a>

        <header className="legal-document__header">
          <p className="legal-document__draft">Шаблон — заменить реквизиты перед публикацией</p>
          <h1>{title}</h1>
          <p>Дата последнего обновления: {updatedAt}</p>
        </header>

        <div className="legal-document__content">
          {sections.map((section, index) => (
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
