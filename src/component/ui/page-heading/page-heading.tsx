import type { ReactNode } from 'react'
import './page-heading.scss'

export default function PageHeading({ title, description, actions, className = '' }: { title: string; description: string; actions?: ReactNode; className?: string }) {
  return <header className={`workspace-page-heading ${className}`}><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="workspace-page-heading__actions">{actions}</div>}</header>
}
