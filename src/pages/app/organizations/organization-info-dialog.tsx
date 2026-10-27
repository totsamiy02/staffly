import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { canAccess } from '../../../app/access/catalog.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { RUSSIAN_TIMEZONES } from '../../../app/organizations/russian-timezones.ts'
import { formatRussianPhone } from '../../../app/profile/phone.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import './organization-info-dialog.scss'

type IconKind = 'organization' | 'email' | 'phone' | 'website' | 'address' | 'timezone' | 'copy'

export function OrganizationInfoIcon({ kind = 'organization' }: { kind?: IconKind }) {
  const paths: Record<IconKind, ReactNode> = {
    organization: <><path d="M5 21V3h10v18M15 8h4v13M3 21h18M8 7h4M8 11h4M8 15h4M9 21v-3h2v3" /></>,
    email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
    phone: <path d="m5 3 4 1 1 5-2 2a14 14 0 0 0 5 5l2-2 5 1 1 4c-1 5-8 2-12-2S2 4 5 3Z" />,
    website: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6h14M5 18h14" /></>,
    address: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    timezone: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}

type Field = { kind: IconKind; label: string; value: string; copyValue?: string; href?: string; action?: string; wide?: boolean }

export default function OrganizationInfoDialog({ organization, onClose }: { organization: OrganizationSummary; onClose: () => void }) {
  const toast = useToast()
  const email = organization.contactEmail?.trim(), phone = organization.phone?.trim()
  const website = organization.website?.trim(), address = organization.address?.trim()
  const timezone = organization.organizationTimezone ?? organization.timezone
  // Only web URLs are actionable; saved text is still available to read and copy.
  const websiteHref = website && /^https?:\/\//i.test(website) ? website : undefined
  const fields: Field[] = [
    ...(email ? [{ kind: 'email' as const, label: 'Рабочая почта', value: email, href: `mailto:${email}`, action: 'Написать' }] : []),
    ...(phone ? [{ kind: 'phone' as const, label: 'Телефон', value: formatRussianPhone(phone), copyValue: phone, href: `tel:${phone.replace(/[^+\d]/g, '')}`, action: 'Позвонить' }] : []),
    ...(website ? [{ kind: 'website' as const, label: 'Сайт', value: website.replace(/^https?:\/\//i, '').replace(/\/$/, ''), copyValue: website, href: websiteHref, action: 'Открыть' }] : []),
    ...(timezone ? [{ kind: 'timezone' as const, label: 'Часовой пояс', value: RUSSIAN_TIMEZONES.find(item => item.value === timezone)?.label ?? timezone }] : []),
    ...(address ? [{ kind: 'address' as const, label: 'Адрес организации', value: address, wide: true }] : []),
  ]

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast('Скопировано в буфер обмена.', 'success') }
    catch { toast('Не удалось скопировать. Выделите и скопируйте значение вручную.', 'error') }
  }

  const settingsParams = new URLSearchParams({ section: 'profile' })
  if (organization.locationId) settingsParams.set('location', organization.locationId)

  return <DocumentDialog title="Об организации" eyebrow="" className="organization-info-dialog" scrollBody onClose={onClose}>
    <div className="organization-info__identity"><Avatar eager url={organization.logoUrl} name={organization.name} className="organization-info__logo" /><div><h3>{organization.name}</h3><p>Общие сведения для всей команды</p></div></div>
    {organization.description?.trim() && <p className="organization-info__description">{organization.description.trim()}</p>}
    <dl className={`organization-info__fields${fields.length === 1 ? ' organization-info__fields--single' : ''}`}>
      {fields.map(field => <div key={field.kind} className={`organization-info__field${field.wide ? ' organization-info__field--wide' : ''}`}>
        <dt><span className="organization-info__field-icon"><OrganizationInfoIcon kind={field.kind} /></span>{field.label}</dt>
        <dd className="organization-info__value"><span>{field.value}</span>{field.href && <a href={field.href} target={field.kind === 'website' ? '_blank' : undefined} rel={field.kind === 'website' ? 'noopener noreferrer' : undefined}>{field.action}</a>}{field.kind === 'address' && <p>Адреса заведений указаны в карточках точек.</p>}
          {field.kind !== 'timezone' && <button className="organization-info__copy" type="button" aria-label={`Скопировать: ${field.label}`} title={`Скопировать: ${field.label}`} onClick={() => void copy(field.copyValue ?? field.value)}><OrganizationInfoIcon kind="copy" /></button>}
        </dd>
      </div>)}
    </dl>
    <footer className="organization-info__footer"><span>Сведения из настроек организации</span>{canAccess(organization, 'organization.edit') && <Link to={`/app/organizations/${organization.id}/settings?${settingsParams}`} onClick={onClose}>Изменить в настройках</Link>}</footer>
  </DocumentDialog>
}
