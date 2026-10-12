import type { OrganizationRole } from '../../../app/organizations/types.ts'
const labels = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' }
export default function RoleBadge({ role, name }: { role: OrganizationRole; name?: string }) { return <span className={`role-badge role-badge--${role.toLowerCase()}`}>{name ?? labels[role]}</span> }
