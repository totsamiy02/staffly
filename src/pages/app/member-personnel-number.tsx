import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/auth/auth-context.tsx'
import { useToast } from '../../component/ui/toast/toast-context.ts'
import type { OrganizationMember } from '../../app/organizations/types.ts'

export default function MemberPersonnelNumber({ organizationId, member, editable, onBusy }: { organizationId: string; member: OrganizationMember; editable: boolean; onBusy: (busy: boolean) => void }) {
  const [value, setValue] = useState(member.personnelNumber ?? ''), { apiRequest } = useAuth(), toast = useToast(), client = useQueryClient()
  const mutation = useMutation({ mutationFn: async () => { onBusy(true); try { await apiRequest(`/organizations/${organizationId}/members/${member.id}/personnel-number`, { method: 'PATCH', body: { personnelNumber: value } }) } finally { onBusy(false) } }, onSuccess: async () => { toast('Табельный номер сохранён.', 'success'); await Promise.all([client.invalidateQueries({ queryKey: ['organization-members', organizationId] }), client.invalidateQueries({ queryKey: ['report-preview', organizationId] })]) } })
  if (!editable) return <dl><div><dt>Табельный номер</dt><dd>{member.personnelNumber || 'Не указан'}</dd></div></dl>
  return <form className="member-personnel-form" onSubmit={event => { event.preventDefault(); mutation.mutate() }}><label><span>Табельный номер</span><input type="text" autoComplete="off" maxLength={32} value={value} disabled={mutation.isPending} onChange={event => setValue(event.target.value)} placeholder="Не указан" /></label><button className="app-secondary" disabled={mutation.isPending || value.trim() === (member.personnelNumber ?? '')}>Сохранить номер</button>{mutation.isError && <p role="alert" className="form-inline-error">{mutation.error.message}</p>}</form>
}
