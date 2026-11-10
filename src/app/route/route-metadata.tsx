import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { usePublishedContent } from '../../features/public-content/content.tsx'
import { metadataHead, pageMetadata, publicPages } from '../../shared/site/metadata.ts'

export default function RouteMetadata() {
  const { pathname } = useLocation()
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const key = publicPages[path]?.key ?? (/^\/guide\/[^/]+$/.test(path) ? 'guide:' + path.slice(7) : '')
  const { item } = usePublishedContent(key, Boolean(key))
  useEffect(() => {
    const image = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content
    const origin = image ? new URL(image).origin : window.location.origin
    const meta = pageMetadata(path, item ? [item] : [])
    const template = document.createElement('template')
    template.innerHTML = metadataHead(meta, origin)
    document.head.querySelectorAll('title,meta[name="description"],meta[name="robots"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"]').forEach(node => node.remove())
    document.head.append(template.content)
  }, [path, item])
  return null
}
