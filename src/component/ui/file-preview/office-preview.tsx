import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { PageControls, ZoomControls } from './controls.tsx'

// No active content, navigation, remote images, fonts, stylesheets or nested frames in document output.
const frameHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif}#pages{padding:16px;box-sizing:border-box}.docx-wrapper{padding:0!important;background:transparent!important}.docx-wrapper>section{margin:0 auto!important}a{pointer-events:none}video,audio,iframe,object,embed{display:none!important}</style></head><body><div id="pages"></div></body></html>`

async function passiveOffice(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const files = Object.values(zip.files)
  if (files.length > 4096) throw new Error('Слишком сложный документ.')
  let total = 0
  for (const file of files) {
    if (file.dir || !/\.(xml|rels)$/i.test(file.name)) continue
    const xml = await file.async('string'); total += xml.length
    if (total > 40 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Документ слишком велик или содержит неподдерживаемую разметку.')
    const tree = new DOMParser().parseFromString(xml, 'application/xml')
    if (tree.querySelector('parsererror')) throw new Error('Повреждена структура документа.')
    for (const relation of tree.getElementsByTagName('Relationship')) if (relation.getAttribute('TargetMode') === 'External') relation.setAttribute('Target', '')
    if (file.name === '[Content_Types].xml') for (const node of Array.from(tree.getElementsByTagName('Override'))) {
      const path = (node.getAttribute('PartName') || '').replace(/^\//, '')
      if (!zip.file(path)) node.remove()
    }
    // Serialize text back into escaped XML before giving it to the presentation renderer.
    zip.file(file.name, new XMLSerializer().serializeToString(tree))
  }
  let order: string[] = []
  if (zip.file('ppt/presentation.xml') && zip.file('ppt/_rels/presentation.xml.rels')) {
    const presentation = new DOMParser().parseFromString(await zip.file('ppt/presentation.xml')!.async('string'), 'application/xml')
    const relationships = new DOMParser().parseFromString(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string'), 'application/xml')
    const targets = new Map(Array.from(relationships.getElementsByTagName('Relationship')).map(node => [node.getAttribute('Id'), node.getAttribute('Target') || '']))
    order = Array.from(presentation.getElementsByTagNameNS('*', 'sldId')).map(node => {
      const target = targets.get(node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')) || ''
      return new URL(target, 'https://preview.invalid/ppt/presentation.xml').pathname.slice(1)
    })
  }
  return { bytes: await zip.generateAsync({ type: 'arraybuffer' }), order }
}
export default function OfficePreview({ blob, slides }: { blob: Blob; slides: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null), pages = useRef<HTMLElement[]>([])
  const [loaded, setLoaded] = useState(0), [page, setPage] = useState(1), [count, setCount] = useState(0), [zoom, setZoom] = useState(1), [error, setError] = useState('')
  useEffect(() => {
    if (!loaded) return
    let active = true, cleanup: (() => void) | undefined
    setCount(0); setPage(1); setError('')
    const doc = frame.current?.contentDocument, container = doc?.getElementById('pages')
    if (!doc || !container) return
    container.replaceChildren()
    void (async () => {
      const { bytes, order } = await passiveOffice(blob)
      if (!active) return
      if (slides) {
        const { init } = await import('pptx-preview')
        if (!active) return
        const preview = init(container, { width: 960, mode: 'list' })
        cleanup = () => preview.destroy()
        await preview.load(bytes)
        const byName = new Map(preview.pptx.slides.map(slide => [slide.name, slide]))
        if (!order.length || order.some(name => !byName.has(name))) throw new Error('Не удалось прочитать все слайды презентации.')
        preview.pptx.slides = order.map(name => byName.get(name)!)
        for (let index = 0; index < order.length; index++) preview.htmlRender.renderSlide(index)
        pages.current = Array.from(container.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper'))
      } else {
        const { renderAsync } = await import('docx-preview')
        if (!active) return
        await renderAsync(bytes, container, container, { breakPages: true, ignoreLastRenderedPageBreak: false, renderAltChunks: false, useBase64URL: true, renderComments: false })
        pages.current = Array.from(container.querySelectorAll<HTMLElement>('section.docx'))
      }
      if (!active) { cleanup?.(); return }
      if (!pages.current.length) throw new Error('В документе нет доступных страниц.')
      setCount(pages.current.length)
    })().catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Не удалось прочитать документ.') })
    return () => { active = false; cleanup?.(); pages.current = [] }
  }, [blob, slides, loaded])
  useEffect(() => {
    if (!count || !frame.current) return
    const iframe = frame.current
    const fit = () => {
      pages.current.forEach((node, index) => { node.style.display = index === page - 1 ? '' : 'none' })
      const node = pages.current[page - 1]
      if (!node) return
      const width = node.offsetWidth || 960
      const scale = Math.min(1, Math.max(240, iframe.clientWidth - 32) / width) * zoom
      const container = iframe.contentDocument?.getElementById('pages')
      if (container) container.style.setProperty('zoom', String(scale))
    }
    fit(); iframe.contentWindow?.scrollTo(0, 0)
    const observer = new ResizeObserver(fit); observer.observe(iframe)
    return () => observer.disconnect()
  }, [page, count, zoom])
  return <div className="file-preview-reader"><div className="file-preview-toolbar"><PageControls page={page} count={Math.max(1, count)} onChange={setPage} noun={slides ? 'Слайд' : 'Страница'} /><ZoomControls zoom={zoom} setZoom={setZoom} /></div><details className="file-preview-notes"><summary>Особенности просмотра</summary><p>{slides ? 'Показаны статичные слайды. Анимация, видео, внешние ссылки и некоторые сложные эффекты не воспроизводятся.' : 'Шрифты и переносы могут отличаться от Word. Страницы разделяются по разрывам, сохранённым в файле; длинная страница прокручивается.'}</p></details>{error ? <div className="file-preview-state" role="alert">Не удалось отобразить документ: {error}</div> : <>{!count && <div className="file-preview-status" role="status">Отрисовываем документ…</div>}<iframe className="file-preview-office" ref={frame} title={slides ? 'Просмотр презентации' : 'Просмотр документа Word'} sandbox="allow-same-origin" srcDoc={frameHtml} onLoad={() => setLoaded(value => value + 1)} /></>}</div>
}
