import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { usePublishedContent } from '../../features/public-content/content.tsx'
import { metadataHead, pageMetadata, publicPages } from '../../shared/site/metadata-core.ts'

export default function RouteMetadata() {
  const { pathname } = useLocation()
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const key = publicPages[path]?.key ?? (/^\/guide\/[^/]+$/.test(path) ? 'guide:' + path.slice(7) : '')
  const { item } = usePublishedContent(key, Boolean(key))
  useEffect(() => {
    const image = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content
    const origin = image ? new URL(image).origin : window.location.origin
    let active = true
    const publications = item ? [item] : []
    function update(meta: ReturnType<typeof pageMetadata>) {
      if (!active) return
      const template = document.createElement('template')
      template.innerHTML = metadataHead(meta, origin)
      document.head.querySelectorAll('title,meta[name="description"],meta[name="robots"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"]').forEach(node => node.remove())
      document.head.append(template.content)
    }
    if (path.startsWith('/guide/')) {
      void import('../../shared/site/metadata.ts')
        .then(module => update(module.pageMetadata(path, publications)))
        .catch(() => update(pageMetadata(path, publications)))
    } else update(pageMetadata(path, publications))
    return () => { active = false }
  }, [path, item])
  return null
}
