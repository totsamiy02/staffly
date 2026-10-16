import { useEffect, useState } from 'react'
import { ZoomControls } from './controls.tsx'
export default function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState(''), [zoom, setZoom] = useState(1), [error, setError] = useState(false)
  useEffect(() => { const object = URL.createObjectURL(blob); setUrl(object); return () => URL.revokeObjectURL(object) }, [blob])
  return <div className="file-preview-reader"><div className="file-preview-toolbar"><ZoomControls zoom={zoom} setZoom={setZoom} /></div><div className="file-preview-scroll">{error ? <p role="alert">Не удалось прочитать изображение.</p> : url && <img className="file-preview-image" src={url} alt={name} onError={() => setError(true)} style={{ width: `${zoom * 100}%` }} />}</div></div>
}
