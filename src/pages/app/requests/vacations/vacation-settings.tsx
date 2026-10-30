import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import DatePicker from '../../../../component/ui/date-picker/date-picker.tsx'
import { displayDate } from '../../../../app/schedule/date-utils.ts'

export default function VacationSettings({ organizationId, canCollect, onMessage, onError }: { organizationId: string; canCollect: boolean; onMessage: (s: string) => void; onError: (s: string) => void }) {
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const [days, setDays] = useState(28)
  const [holidays, setHolidays] = useState<string[]>([])
  const [pickedDate, setPickedDate] = useState(''), [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const settings = useQuery({ queryKey: ['vacation-settings', organizationId], queryFn: () => apiRequest<{ standardDays: number; holidays: string[] }>(`/organizations/${organizationId}/vacation-settings`) })
  useEffect(() => { if (settings.data && !dirty) { setDays(settings.data.standardDays); setHolidays(settings.data.holidays) } }, [settings.data, dirty])
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      await apiRequest(`/organizations/${organizationId}/vacation-settings`, { method: 'PUT', body: { standardDays: days, holidays } })
      await client.invalidateQueries({ queryKey: ['vacation-settings', organizationId] })
      await client.invalidateQueries({ queryKey: ['vacations', organizationId] })
      setDirty(false)
      onMessage('Настройки отпусков сохранены.')
    } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось сохранить настройки.') }
    finally { setBusy(false) }
  }
  return <section className="vacation-settings">
    <div className="vacation-settings-heading"><div><h3>Планирование отпусков</h3><p>Здесь задаются правила для новых сборов. Сами пожелания сотрудников собираются в разделе «Заявки → Отпуска и сбор дат».</p></div>{canCollect && <Link className="app-secondary" to={`/app/organizations/${organizationId}/requests?tab=vacations`}>Перейти к отпускам</Link>}</div>
    <form onSubmit={save}>
      <label className="vacation-settings-days"><span>Продолжительность отпуска, дней</span><input type="number" required min={28} max={366} value={days} onChange={e => { setDays(Number(e.target.value)); setDirty(true) }} disabled={busy || settings.isLoading || settings.isError}/><small>По умолчанию — 28. В каждом сборе продолжительность можно уточнить.</small></label>
      <details className="holiday-editor"><summary><span>Праздничные дни организации</span><small>{holidays.length ? `Выбрано: ${holidays.length}` : 'Дополнительно к федеральным'}</small></summary><p>Добавьте особые праздничные даты вашей организации. Федеральные праздники уже учтены; перенесённые выходные добавлять не нужно.</p><div className="holiday-editor__add"><label><span>Выбрать день</span><DatePicker aria-label="Праздничная дата" value={pickedDate} onChange={event => setPickedDate(event.target.value)} disabled={busy || settings.isPending || settings.isError}/></label><button type="button" className="app-secondary" disabled={!pickedDate || holidays.includes(pickedDate) || busy} onClick={() => { setHolidays([...holidays,pickedDate].sort()); setPickedDate(''); setDirty(true) }}>Добавить дату</button></div><div className="holiday-editor__dates">{holidays.map(day => <span key={day}>{displayDate(day)}<button type="button" disabled={busy} aria-label={`Удалить дату ${displayDate(day)}`} onClick={() => { setHolidays(holidays.filter(d => d !== day)); setDirty(true) }}>×</button></span>)}{!holidays.length && <small>Дополнительные праздники пока не выбраны.</small>}</div></details>
      {settings.isError && <p role="alert">Не удалось загрузить настройки. <button type="button" className="app-secondary" onClick={() => void settings.refetch()}>Повторить</button></p>}
      <div className="vacation-settings-footer"><button className="app-secondary" disabled={busy || settings.isLoading || settings.isError}>{busy ? 'Сохраняем…' : 'Сохранить правила'}</button><small>Индивидуальные условия учитываются при выборе периодов. Расчёт отпускных и кадровые документы ведутся отдельно.</small></div>
    </form>
  </section>
}
