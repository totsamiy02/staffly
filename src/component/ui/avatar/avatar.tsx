type AvatarProps = {
  url: string | null | undefined
  name: string
  className: string
  eager?: boolean
}

export default function Avatar({ url, name, className, eager = false }: AvatarProps) {
  return <span className={`${className} media-avatar`} aria-hidden="true">
    {url ? <img src={url} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} /> : name.trim().slice(0, 1).toUpperCase()}
  </span>
}
