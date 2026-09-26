import { useState } from 'react'

type AvatarProps = {
  url: string | null | undefined
  name: string
  className: string
  eager?: boolean
}

export default function Avatar({ url, name, className, eager = false }: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return <span className={`${className} media-avatar`} aria-hidden="true">
    {url && failedUrl !== url ? <img src={url} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} onError={() => setFailedUrl(url)} /> : name.trim().slice(0, 1).toUpperCase()}
  </span>
}
