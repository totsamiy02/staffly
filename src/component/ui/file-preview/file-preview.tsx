import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { fileExtension, isPresentation } from '../../../app/file-preview/formats.ts'
import { LEGACY_PREVIEW_MIME, SHEET_PREVIEW_MIME, type LegacyPreview, type WorkbookPreview } from '../../../app/file-preview/types.ts'
import './file-preview.scss'
const PdfPreview = lazy(() => import('./pdf-preview.tsx'))
const TablePreview = lazy(() => import('./table-preview.tsx'))
const TextPreview = lazy(() => import('./text-preview.tsx'))
const ImagePreview = lazy(() => import('./image-preview.tsx'))
const OfficePreview = lazy(() => import('./office-preview.tsx'))
const LegacyReader = lazy(() => import('./legacy-preview.tsx'))
type Content = { blob: Blob; text?: string; workbook?: WorkbookPreview; legacy?: LegacyPreview; office?: boolean }
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="file-preview-state" role="alert"><strong>Не удалось отобразить файл</strong><p>Закройте просмотр и откройте файл повторно.</p></div> : this.props.children }
}
/** Reusable reader. Authorization/transport belong to the caller; no organization or auth dependencies here. */
export default function FilePreview({ sourceKey, name, load, onLoaded }: { sourceKey: string; name: string; load: () => Promise<Blob>; onLoaded?: () => void }) {
  const [content, setContent] = useState<Content | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [full, setFull] = useState(false)
  const root = useRef<HTMLDivElement>(null), transport = useRef(load), ready = useRef(onLoaded)
  transport.current = load; ready.current = onLoaded
  useEffect(() => {
    let active = true
    setContent(null); setError('')
    void transport.current().then(async blob => {
      const next: Content = { blob }
      if (blob.type === SHEET_PREVIEW_MIME) next.workbook = JSON.parse(await blob.text()) as WorkbookPreview
      else if (blob.type === LEGACY_PREVIEW_MIME) next.legacy = JSON.parse(await blob.text()) as LegacyPreview
      else if (['docx', 'pptx'].includes(fileExtension(name))) next.office = true
      else if (blob.type.startsWith('text/')) next.text = await blob.text()
      else if (blob.type !== 'application/pdf' && !blob.type.startsWith('image/')) throw new Error('Сервер вернул неизвестный формат просмотра.')
      if (active) { setContent(next); ready.current?.() }
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Не удалось открыть файл.') })
    return () => { active = false }
  }, [sourceKey, name, retry])
  useEffect(() => { const change = () => setFull(document.fullscreenElement === root.current); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change) }, [])
  return <div className="file-preview" ref={root} onKeyDownCapture={event => { if (event.key === 'Escape' && document.fullscreenElement === root.current) event.stopPropagation() }}>
    <div className="file-preview-topbar"><span>Только чтение</span>{document.fullscreenEnabled && <button type="button" className="file-preview-expand" onClick={() => { void (full ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => setError('Полноэкранный режим недоступен в этом браузере.')) }}>{full ? 'Свернуть' : 'На весь экран'}</button>}</div>
    {error ? <div className="file-preview-state" role="alert"><strong>Не удалось открыть просмотр</strong><p>{error}</p><button type="button" className="app-secondary" onClick={() => setRetry(value => value + 1)}>Повторить</button></div> : !content ? <div className="file-preview-state" role="status"><span className="app-spinner" /><strong>Подготавливаем просмотр…</strong><p>Большой документ может открываться немного дольше.</p></div> : <PreviewBoundary key={`${sourceKey}:${retry}`}><Suspense fallback={<div className="file-preview-state" role="status">Загружаем просмотрщик…</div>}>{content.office ? <OfficePreview blob={content.blob} slides={isPresentation(name)} /> : content.legacy ? <LegacyReader value={content.legacy} /> : content.workbook ? <TablePreview workbook={content.workbook} /> : content.text !== undefined ? <TextPreview value={content.text} markdown={fileExtension(name) === 'md'} /> : content.blob.type === 'application/pdf' ? <PdfPreview blob={content.blob} slides={isPresentation(name)} /> : <ImagePreview blob={content.blob} name={name} />}</Suspense></PreviewBoundary>}
  </div>
}
