import type { OrganizationMember } from '../../../app/organizations/types.ts'
import Select from '../../../component/ui/select/select.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'

type Employee = Pick<OrganizationMember, 'id' | 'displayName' | 'email' | 'avatarUrl'> & { disabledReason?: string | null }
type Props = { members: Employee[]; value: string; onChange: (id: string) => void; label?: string; emptyLabel?: string; required?: boolean; disabled?: boolean }

// The same searchable Staffly select is used for assigning shifts and inspecting hours.
export default function EmployeePicker({ members, value, onChange, label = 'Сотрудник', emptyLabel = 'Выберите сотрудника', required = true, disabled = false }: Props) {
  return <label className="employee-picker"><span>{label}</span><Select aria-label={label} searchable value={value} onChange={event => onChange(event.target.value)} required={required} disabled={disabled}><option value="" data-search={emptyLabel}>{emptyLabel}</option>{members.map(member => <option key={member.id} value={member.id} disabled={!!member.disabledReason} data-search={`${member.displayName} ${member.email}`}><span className="staffly-select__person"><Avatar eager url={member.avatarUrl} name={member.displayName} className="employee-picker__avatar" /><span><strong>{member.displayName}</strong>{(member.disabledReason || member.email) && <small>{member.disabledReason || member.email}</small>}</span></span></option>)}</Select></label>
}
