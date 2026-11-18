import { Children, isValidElement, lazy, Suspense, useLayoutEffect, useRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { guideExampleIds, type GuideExampleId } from '../../pages/guide/content/types.ts'

const Example = lazy(() => import('../../pages/guide/guide-example-block.tsx'))

function headingText(value: ReactNode): string {
  return Children.toArray(value).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? headingText(child.props.children) : '').join('')
}
export default function PublishedMarkdown({ children, anchorPrefix = '', preservedAnchors = [] }: { children: string; anchorPrefix?: string; preservedAnchors?: string[] }) {

  const root = useRef<HTMLDivElement>(null), anchors = preservedAnchors.join('|')

  useLayoutEffect(() => {

    if (!root.current) return

    const existing = new Set([...root.current.querySelectorAll('[id]')].map(node => node.id)), aliases: HTMLElement[] = []

    for (const id of anchors.split('|').filter(Boolean)) {
      const full = anchorPrefix + id
      if (!existing.has(full)) {
        const alias = document.createElement('span')
        alias.id = full
        alias.setAttribute('aria-hidden', 'true')
        root.current.prepend(alias)
        aliases.push(alias)
        existing.add(full)
      }
    }

    return () => aliases.forEach(node => node.remove())

  }, [children, anchors, anchorPrefix])

  const heading = (Tag: 'h2' | 'h3', value: ReactNode) => {
    const parts = Children.toArray(value), last = parts.at(-1), match = typeof last === 'string' ? last.match(/\s*\{#([a-zA-Z0-9_-]{1,100})\}$/) : null
    if (match && typeof last === 'string') parts[parts.length - 1] = last.slice(0, -match[0].length)
    const id = anchorPrefix + (match?.[1] ?? headingText(parts).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''))
    return <Tag id={id}>
      {parts}
    </Tag>
  }

  return <div ref={root} className="published-content">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{

        a: ({ children, href }) => <a href={href?.startsWith('#') ? '#' + anchorPrefix + href.slice(1) : href} rel="noreferrer">
          {children}
        </a>,
        img: ({ alt }) => <span>
          {alt}
        </span>,
        h2: ({ children }) => heading('h2', children),
        h3: ({ children }) => heading('h3', children),

        pre: ({ children, node }) => node?.children.some(child => child.type === 'element' && child.properties?.className?.toString().includes('language-staffly-example')) ? <div className="published-guide-example">
          {children}
        </div> : <pre>
          {children}
        </pre>,

        code: ({ children, className }) => className === 'language-staffly-example' && guideExampleIds.includes(String(children).trim() as GuideExampleId) ? <Suspense fallback={<p role="status">Загружаем пример…</p>}>
          <Example example={String(children).trim() as GuideExampleId} />
        </Suspense> : <code className={className}>
          {children}
        </code>

      }}>
      {children}
    </ReactMarkdown>
  </div>
}

