import { useMemberProfile } from '../../../app/member-profile/context.tsx'
import type { OrganizationMember } from '../../../app/organizations/types.ts'
import Select from '../../../component/ui/select/select.tsx'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import './employee-picker.scss'

type Employee = Pick<OrganizationMember, 'id' | 'displayName' | 'email' | 'avatarUrl'> & { disabledReason?: string | null; secondary?: string }
type Props = { members: Employee[]; value: string; onChange: (id: string) => void; label?: string; emptyLabel?: string; required?: boolean; disabled?: boolean }

// The same searchable Staffly select is used for assigning shifts and inspecting hours.
export default function EmployeePicker({ members, value, onChange, label = 'Сотрудник', emptyLabel = 'Выберите сотрудника', required = true, disabled = false }: Props) {
  const profile = useMemberProfile()
  return <div className="employee-picker-profile"><label className="employee-picker"><span>{label}</span>
    <Select onOpenPerson={profile ? id => profile.open(id) : undefined} canOpenPerson={profile?.canOpen} aria-label={label} searchable value={value} onChange={event => onChange(event.target.value)} required={required} disabled={disabled}>
      <option value="" data-search={emptyLabel}>{emptyLabel}</option>
      {members.map(member => {
        const secondary = member.disabledReason || member.secondary || (member.email !== member.displayName ? member.email : '')
        return <option key={member.id} value={member.id} disabled={!!member.disabledReason} data-search={`${member.displayName} ${member.email} ${member.secondary ?? ''}`}>
          <span className="staffly-select__person"><Avatar eager url={member.avatarUrl} name={member.displayName} className="employee-picker__avatar" /><span><strong>{member.displayName}</strong>{secondary && <small>{secondary}</small>}</span></span>
        </option>
      })}
    </Select>
  </label></div>
}
