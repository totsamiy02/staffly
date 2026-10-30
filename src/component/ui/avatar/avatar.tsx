import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useMediaSession } from '../../../app/auth/auth-context.tsx'

type AvatarProps = { url: string | null | undefined; name: string; className: string; eager?: boolean }

export default function Avatar({ url, name, className, eager = false }: AvatarProps) {
  const session = useMediaSession()
  const container = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(eager)
  useEffect(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '100px' })
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [eager])
  const privateMedia = !!session?.user && !!url?.startsWith('/api/media/')
  const key = `${session?.user?.id ?? ''}:${url ?? ''}`
  const image = useQuery({ queryKey: ['private-media', key], enabled: privateMedia && visible,
    queryFn: ({ signal }) => session!.previewFile(url!.slice(4), 'GET', AbortSignal.any([signal, AbortSignal.timeout(15000)])),
    retry: (count, error: Error & { status?: number }) => count < 2 && (!error.status || error.status >= 500), retryDelay: n => 500 * (n + 1),
    staleTime: 30000, gcTime: 0, refetchOnWindowFocus: 'always', refetchOnReconnect: 'always' })
  const [object, setObject] = useState<{ key: string; url: string } | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!privateMedia || !image.data) return
    const objectUrl = URL.createObjectURL(image.data)
    setObject({ key, url: objectUrl })
    return () => URL.revokeObjectURL(objectUrl)
  }, [key, privateMedia, image.data])
  const denied = image.isError && [401, 403, 404].includes((image.error as Error & { status?: number })?.status ?? 0)
  const source = privateMedia ? !denied && object?.key === key ? object.url : null : url
  return <span ref={container} className={`${className} media-avatar`} aria-hidden="true">
    {source && failedUrl !== source ? <img src={source} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} onError={() => setFailedUrl(source)} /> : name.trim().slice(0, 1).toUpperCase()}
  </span>
}
