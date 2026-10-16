import { useState } from 'react'
import type { LegacyPreview } from '../../../app/file-preview/types.ts'
import { PageControls, ZoomControls } from './controls.tsx'
export default function LegacyReader({ value }: { value: LegacyPreview }) {
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1)
  return <><div className="file-preview-toolbar"><PageControls page={page} count={Math.max(1, value.pages.length)} onChange={setPage} noun={value.kind === 'slides' ? 'Слайд' : 'Часть'} /><ZoomControls zoom={zoom} setZoom={setZoom} /></div><p className="file-preview-notice">{value.warning}</p><div className="file-preview-scroll"><article className="file-preview-prose" style={{ fontSize: `${16 * zoom}px`, whiteSpace: 'pre-wrap' }}>{value.pages[page - 1] || 'В файле нет доступного текста.'}</article></div></>
}
