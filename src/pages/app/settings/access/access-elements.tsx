import type { ReactNode } from 'react'
import type { Permission } from '../../../../app/access/catalog.ts'
import { permissionHints } from './access-presentation.ts'

const icons: Record<string, ReactNode> = {
  briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3" /></>,
  shield: <><path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  crown: <><path d="m3 6 4 4 5-6 5 6 4-4-2 12H5L3 6Z" /><path d="M6 21h12" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2" /></>,
  absence: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2M4 4l16 16" /></>,
  requests: <><path d="M4 4h16v12H9l-5 4V4Z" /><path d="M8 8h8m-8 4h5" /></>,
  exchange: <><path d="M3 7h17l-4-4m4 14H3l4 4M20 7l-4 4M3 17l4-4" /></>,
  chart: <><path d="M4 3v18h17M8 16v-4m5 4V8m5 8V5" /></>,
  document: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 12h8m-8 4h5" /></>,
  pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
  building: <><rect x="4" y="3" width="12" height="18" rx="2" /><path d="M16 9h4v12H9v-5h3v5M8 7h4m-4 4h4" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  history: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
}

export function AccessIcon({ name, className = '' }: { name: string; className?: string }) {
  return <svg className={`access-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name] ?? icons.shield}</svg>
}

export function AccessNote({ children, protectedNote = false }: { children: ReactNode; protectedNote?: boolean }) {
  return <div className={`access-note${protectedNote ? ' access-note--protected' : ''}`}><AccessIcon name={protectedNote ? 'lock' : 'info'} /><div>{children}</div></div>
}

export function AccessPermission({ permission, enabled, disabled = false, onChange }: { permission: { key: Permission; label: string }; enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
  return <label className={`access-permission${enabled ? ' is-enabled' : ''}`}>
    <input type="checkbox" disabled={disabled} checked={enabled} onChange={event => onChange(event.target.checked)} />
    <span className="access-checkbox" aria-hidden="true"><AccessIcon name="check" /></span><span className="access-permission__text"><strong>{permission.label}</strong>{permissionHints[permission.key] && <small>{permissionHints[permission.key]}</small>}</span>
  </label>
}
