import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { canAccess } from '../../../app/access/catalog.ts'
import { useTeamSettings } from '../../../app/schedule/team-planning.ts'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { TeamPlanningSettings as Settings } from '../../../app/schedule/team-planning-types.ts'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import PlanningIcon from './planning-icon.tsx'
import './team-planning.scss'
export default function TeamPlanningSettings({organization}:{organization:OrganizationSummary}) {
  const settings=useTeamSettings(organization.id),{apiRequest,locationId}=useAuth(),client=useQueryClient(),toast=useToast()
  const [pending,setPending]=useState<Settings|null>(null),[error,setError]=useState('')
  if(settings.isLoading)return <p className="planning-empty">Загружаем настройки планирования…</p>
  if(settings.isError||!settings.data)return <p className="form-inline-error" role="alert">Не удалось загрузить настройки. <button onClick={()=>void settings.refetch()}>Повторить</button></p>
  const value=pending??settings.data,manage=canAccess(organization,'schedule.settings'),busy=!!pending
  async function save(next:Settings) {
    setPending(next);setError('')
    try {
      const saved=await apiRequest<Settings>(`/organizations/${organization.id}/schedule/team-settings`,{method:'PUT',body:next})
      client.setQueryData(['team-planning-settings',organization.id,locationId],saved)
      toast('Настройка сохранена','success');await invalidateOrganizationWork(client,organization.id)
    } catch(e) {setError(e instanceof Error?e.message:'Не удалось сохранить настройку.')}
    finally {setPending(null)}
  }
  return <section className="team-planning planning-options">
    <header><h3>Планирование команды</h3><p>Дополнительные инструменты точки «{organization.location?.name}». Изменения сохраняются сразу.</p></header>
    <div className="planning-option"><span className="planning-option__icon" aria-hidden="true"><PlanningIcon name="coverage"/></span><div><strong>Потребность и покрытие</strong><p>Задайте, сколько людей нужно по должностям и времени. В календаре будет видно, где не хватает сотрудников.</p></div><button type="button" role="switch" aria-checked={value.coverageEnabled} aria-label="Потребность и покрытие" className="planning-toggle" disabled={!manage||busy} onClick={()=>void save({...value,coverageEnabled:!value.coverageEnabled})}><i/></button></div>
    <div className="planning-option"><span className="planning-option__icon" aria-hidden="true"><PlanningIcon name="people"/></span><div><strong>Согласование графика</strong><p>Подготовьте график в разделе «Расписание → Согласование» и обсудите его с командой перед применением.</p></div><button type="button" role="switch" aria-checked={value.discussionEnabled} aria-label="Согласование графика" className="planning-toggle" disabled={!manage||busy} onClick={()=>void save({...value,discussionEnabled:!value.discussionEnabled})}><i/></button></div>
    <p className="planning-footnote">Чтобы выключить согласование, сначала примените или отмените незавершённые графики. Обычные смены можно назначать напрямую.</p>
    {busy&&<p className="planning-footnote" role="status">Сохраняем настройку…</p>}
    {error&&<p className="form-inline-error" role="alert">{error}</p>}
  </section>
}
