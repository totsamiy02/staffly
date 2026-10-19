import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'

export default function VacationSettings({ organizationId, canCollect, onMessage, onError }: { organizationId: string; canCollect: boolean; onMessage: (s: string) => void; onError: (s: string) => void }) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const [days, setDays] = useState(28)
  const [holidays, setHolidays] = useState('')
  const [busy, setBusy] = useState(false)
  const settings = useQuery({ queryKey: ['vacation-settings', organizationId], queryFn: () => apiRequest<{ standardDays: number; holidays: string[] }>(`/organizations/${organizationId}/vacation-settings`) })
  useEffect(() => { if (settings.data) { setDays(settings.data.standardDays); setHolidays(settings.data.holidays.join('\n')) } }, [settings.data])
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      await apiRequest(`/organizations/${organizationId}/vacation-settings`, { method: 'PUT', body: { standardDays: days, holidays: holidays.split(/\s+/).filter(Boolean) } })
      await client.invalidateQueries({ queryKey: ['vacation-settings', organizationId] })
      await client.invalidateQueries({ queryKey: ['vacations', organizationId] })
      onMessage('Настройки отпусков сохранены.')
    } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось сохранить настройки.') }
    finally { setBusy(false) }
  }
  return <section className="vacation-settings">
    <div className="vacation-settings-heading"><div><h3>Планирование отпусков</h3><p>Здесь задаются правила для новых сборов. Сами пожелания сотрудников собираются в разделе «Заявки → Отпуска и сбор дат».</p></div>{canCollect && <Link className="app-secondary" to={`/app/organizations/${organizationId}/requests?tab=vacations`}>Перейти к отпускам</Link>}</div>
    <form onSubmit={save}>
      <label className="vacation-settings-days"><span>Продолжительность отпуска, дней</span><input type="number" required min={28} max={366} value={days} onChange={e => setDays(Number(e.target.value))} disabled={settings.isLoading || settings.isError}/><small>По умолчанию — 28. В каждом сборе продолжительность можно уточнить.</small></label>
      <details className="request-builder-disclosure"><summary>Дополнительные праздничные даты</summary><p>Заполняйте, только если в организации есть дополнительные нерабочие праздничные дни. Федеральные праздники уже учтены; перенесённые выходные добавлять не нужно.</p><label><span>По одной дате в строке</span><textarea rows={3} value={holidays} onChange={e => setHolidays(e.target.value)} placeholder={'2027-04-21\n2027-08-30'} disabled={settings.isLoading || settings.isError}/><small>Формат: ГГГГ-ММ-ДД. Например, 2027-04-21.</small></label></details>
      {settings.isError && <p role="alert">Не удалось загрузить настройки. <button type="button" className="app-secondary" onClick={() => void settings.refetch()}>Повторить</button></p>}
      <div className="vacation-settings-footer"><button className="app-secondary" disabled={busy || settings.isLoading || settings.isError}>{busy ? 'Сохраняем…' : 'Сохранить правила'}</button><small>Индивидуальные условия учитываются при выборе периодов. Расчёт отпускных и кадровые документы ведутся отдельно.</small></div>
    </form>
  </section>
}
