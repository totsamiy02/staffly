import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PageControls, ZoomControls } from './controls.tsx'
const CHUNK = 40_000
function safeUrl(url: string) { return /^(https?:\/\/|mailto:|#)/i.test(url) ? url : '' }
export default function TextPreview({ value, markdown }: { value: string; markdown: boolean }) {
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1)
  const formatted = markdown && value.length <= 500_000
  const pages = formatted ? 1 : Math.max(1, Math.ceil(value.length / CHUNK))
  return <div className="file-preview-reader"><div className="file-preview-toolbar"><ZoomControls zoom={zoom} setZoom={setZoom} />{pages > 1 && <PageControls page={page} count={pages} onChange={setPage} />}</div>
    {markdown && !formatted && <p className="file-preview-notes">Большой Markdown показан как текст с постраничной навигацией, чтобы сохранить быстродействие.</p>}
    <div className="file-preview-scroll" key={page}><article className="file-preview-prose" style={{ fontSize: `${15 * zoom}px` }}>{!value ? <p>Файл пуст.</p> : formatted ? <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>, img: ({ alt, src }) => <span className="file-preview-external-image">Изображение: {alt || 'без подписи'}{src && <a href={src} target="_blank" rel="noopener noreferrer">Открыть по ссылке</a>}</span> }}>{value}</Markdown> : <pre>{value.slice((page - 1) * CHUNK, page * CHUNK)}</pre>}</article></div>
  </div>
}
