import { useEffect, useRef, useState, type ReactNode } from 'react'
import './file-preview.scss'
import './spreadsheet-surface.scss'

/** Read-only workbook chrome shared by uploaded documents and generated reports. */
export default function SpreadsheetSurface({ toolbar, notes, footer, sheets, children, expandable = false, className = '' }: { toolbar: ReactNode; notes?: ReactNode; footer: ReactNode; sheets: ReactNode; children: ReactNode; expandable?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false), [fullscreenError, setFullscreenError] = useState('')
  useEffect(() => { const change = () => setFull(document.fullscreenElement === ref.current); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change) }, [])
  return <div onKeyDownCapture={event => { if (event.key === 'Escape' && document.fullscreenElement === ref.current) event.stopPropagation() }} ref={ref} className={`file-preview-reader spreadsheet-surface ${className}`}>
    {expandable && <div className="file-preview-topbar"><span>Только чтение</span>{document.fullscreenEnabled && <button type="button" className="file-preview-expand" onClick={() => { const element = ref.current; if (document.fullscreenElement === element) void document.exitFullscreen(); else void element?.requestFullscreen().catch(() => setFullscreenError('Полноэкранный режим недоступен в этом браузере.')) }}>{full ? 'Свернуть' : 'На весь экран'}</button>}</div>}
    {fullscreenError && <p className="file-preview-notice" role="status">{fullscreenError}</p>}
    <div className="file-preview-toolbar">{toolbar}</div>{notes}{children}
    <div className="file-preview-toolbar file-preview-table-footer">{footer}</div>{sheets}
  </div>
}
