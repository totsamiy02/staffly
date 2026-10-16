import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer, version, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { PageControls, ZoomControls } from './controls.tsx'
GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfPreview({ blob, slides = false }: { blob: Blob; slides?: boolean }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [zoom, setZoom] = useState(1)
  const [error, setError] = useState(''), [busy, setBusy] = useState(true), [width, setWidth] = useState(600)
  const [passwordPrompt, setPasswordPrompt] = useState(false), [password, setPassword] = useState('')
  const passwordCallback = useRef<((value: string) => void) | null>(null)
  const scroll = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = scroll.current; if (!node) return
    const observer = new ResizeObserver(entries => setWidth(Math.max(180, entries[0].contentRect.width - 32)))
    observer.observe(node); return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let disposed = false; let task: ReturnType<typeof getDocument> | undefined
    setPdf(null); setError(''); setBusy(true); setPage(1)
    void blob.arrayBuffer().then(buffer => {
      if (disposed) return
      const root = `/pdfjs/${version}/`
      task = getDocument({ data: new Uint8Array(buffer), cMapUrl: `${root}cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}standard_fonts/`, wasmUrl: `${root}wasm/`, useSystemFonts: true })
      task.onPassword = (update: (value: string) => void) => { passwordCallback.current = update; setPasswordPrompt(true); setBusy(false) }
      return task.promise.then(document => { if (!disposed) { setPdf(document); setPasswordPrompt(false) } })
    }).catch(() => { if (!disposed) { setError('Не удалось прочитать страницы. Файл может быть повреждён.'); setBusy(false) } })
    return () => { disposed = true; passwordCallback.current = null; void task?.destroy() }
  }, [blob])
  useEffect(() => {
    if (!pdf || !canvas.current || !text.current || !sheet.current) return
    let disposed = false; let render: RenderTask | undefined; let layer: TextLayer | undefined
    const target = canvas.current, textNode = text.current, pageNode = sheet.current
    setBusy(true); setError(''); textNode.replaceChildren(); scroll.current?.scrollTo(0, 0)
    void pdf.getPage(page).then(async current => {
      if (disposed) return
      const base = current.getViewport({ scale: 1 }), scale = Math.min(width / base.width * zoom, 4)
      const viewport = current.getViewport({ scale })
      // Cap backing pixels to avoid huge canvases on scans and high-DPI screens.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)))
      pageNode.style.width = `${viewport.width}px`; pageNode.style.height = `${viewport.height}px`
      pageNode.style.setProperty('--scale-factor', String(scale)); pageNode.style.setProperty('--total-scale-factor', String(scale))
      target.width = Math.floor(viewport.width * ratio); target.height = Math.floor(viewport.height * ratio)
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
      render = current.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      await render.promise
      if (disposed) return
      layer = new TextLayer({ textContentSource: await current.getTextContent(), container: textNode, viewport })
      await layer.render()
      if (!disposed) setBusy(false)
    }).catch(failure => { if (!disposed && failure?.name !== 'RenderingCancelledException') { setError('Не удалось отобразить эту страницу. Попробуйте другую страницу или откройте файл снова.'); setBusy(false) } })
    return () => { disposed = true; render?.cancel(); layer?.cancel() }
  }, [pdf, page, width, zoom])
  return <div className="file-preview-reader"><div className="file-preview-toolbar">{pdf && <PageControls page={page} count={pdf.numPages} onChange={setPage} noun={slides ? 'Слайд' : 'Страница'} />}<ZoomControls zoom={zoom} setZoom={setZoom} /></div>
    {passwordPrompt && <form className="file-preview-password" onSubmit={event => { event.preventDefault(); passwordCallback.current?.(password); setPassword(''); setPasswordPrompt(false); setBusy(true) }}><label>Пароль PDF<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="app-primary">Открыть</button><p>Пароль используется только в этом окне.</p></form>}
    {busy && <div className="file-preview-status" role="status"><span className="app-spinner" />Подготавливаем страницу…</div>}
    {error && <p className="file-preview-status" role="alert">{error}</p>}
    <div className="file-preview-scroll" ref={scroll} tabIndex={0} aria-label={slides ? 'Просмотр слайда' : 'Просмотр страницы'} onKeyDown={event => { if (event.target !== event.currentTarget || !pdf) return; if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); setPage(p => Math.min(pdf.numPages, p + 1)) } if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); setPage(p => Math.max(1, p - 1)) } }}>
      <div ref={sheet} className="file-preview-pdf-page" style={{ visibility: pdf && !passwordPrompt ? 'visible' : 'hidden' }}><canvas ref={canvas} aria-label={`${slides ? 'Слайд' : 'Страница'} ${page}`} /><div ref={text} className="textLayer" /></div>
    </div></div>
}
