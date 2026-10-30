import { useState } from 'react'
import type { GuideArticle, GuideExampleId } from './content/types.ts'
import GuideExample from './guide-examples.tsx'
import { guideExampleLabels } from './guide-example-labels.ts'
import GuideIcon from './guide-icon.tsx'
import AnimatedOverlay from '../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../component/ui/modal/document-dialog.tsx'

/** Complete content shared by module readers and direct article links. */
export default function GuideArticleContent({ article, continuous = false }: { article: GuideArticle; continuous?: boolean }) {
  const [zoom, setZoom] = useState<GuideExampleId | null>(null)
  const Heading = continuous ? 'h3' : 'h2'
  const StepHeading = continuous ? 'h4' : 'h3'
  return <>
    {article.sections.map(section => {
      const id = continuous ? `${article.slug}-${section.id}` : section.id
      return <section className="guide-article-section" id={id} key={section.id}>
        <Heading><a href={`#${id}`}>{section.title}</a></Heading>
        {section.paragraphs?.map(text => <p key={text}>{text}</p>)}
        {section.items && <ul className="guide-facts">{section.items.map(text => <li key={text}><GuideIcon name="check" /><span>{text}</span></li>)}</ul>}
        {section.steps && <ol className="guide-steps">{section.steps.map((step, index) => <li key={step.title}><span className="guide-step-number">{index + 1}</span><div><StepHeading>{step.title}</StepHeading><p>{step.text}</p></div></li>)}</ol>}
        {section.table && <div className="guide-table-scroll" role="region" aria-label={section.title} tabIndex={0}><table><thead><tr>{section.table.headings.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{section.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
        {section.example && <figure className="guide-figure"><div className="guide-figure__frame"><div className="guide-figure__label"><GuideIcon name="window" />В интерфейсе Staffly</div><GuideExample example={section.example} /><button type="button" onClick={() => setZoom(section.example!)} aria-label={`Увеличить: ${guideExampleLabels[section.example]}`}><GuideIcon name="zoom" />Увеличить</button></div><figcaption>{guideExampleLabels[section.example]} · фрагмент интерфейса с вымышленными данными</figcaption></figure>}
        {section.note && <aside className="guide-note"><GuideIcon name="bulb" /><div><strong>Полезно знать</strong><p>{section.note}</p></div></aside>}
      </section>
    })}
    {!!article.questions?.length && <section className="guide-article-section" id={continuous ? `${article.slug}-questions` : 'questions'}><Heading>Вопросы и ответы</Heading>{article.questions.map(item => continuous ? <div className="guide-reader-question" key={item.question}><StepHeading>{item.question}</StepHeading><p>{item.answer}</p></div> : <details className="guide-question" key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</section>}
    {zoom && <AnimatedOverlay variant="modal" className="guide-example-overlay" onClose={() => setZoom(null)}>{close => <DocumentDialog title={guideExampleLabels[zoom]} eyebrow="Пример интерфейса" className="guide-example-dialog" onClose={close}><div className="guide-example-stage" role="region" aria-label="Увеличенный пример интерфейса, доступна горизонтальная прокрутка" tabIndex={0}><GuideExample example={zoom} /></div><p>Вымышленные данные. Элементы внутри примера не выполняют действия.</p></DocumentDialog>}</AnimatedOverlay>}
  </>
}
