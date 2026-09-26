import type { OrganizationRole } from '../../../app/organizations/types.ts'
const labels = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Сотрудник' }
export default function RoleBadge({ role }: { role: OrganizationRole }) { return <span className={`role-badge role-badge--${role.toLowerCase()}`}>{labels[role]}</span> }
