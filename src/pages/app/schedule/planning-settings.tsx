import { useToastFeedback } from '../../../component/ui/toast/toast-context.ts'
import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { useSchedulePlanning, type Position, type ShiftTemplate } from '../../../app/schedule/planning.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import Select from '../../../component/ui/select/select.tsx'
import { TimeInput } from '../../../component/ui/date-picker/date-picker.tsx'
import { Link } from 'react-router-dom'
import './schedule.scss'

export default function PlanningSettings({ organization }: { organization: OrganizationSummary }) {
  const planning = useSchedulePlanning(organization.id)
  const { apiRequest } = useAuth()
  const queryClient = useQueryClient()
  const [position, setPosition] = useState<Position | null>(null)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<ShiftTemplate | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [positionId, setPositionId] = useState('')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('18:00')
  const [overnight, setOvernight] = useState(false)
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [feedbackScope, setFeedbackScope] = useState('')
  const [tab, setTab] = useState('positions')
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(''), 4500); return () => window.clearTimeout(timer) }, [message])
  function feedback(scope: string) { return feedbackScope === scope ? <>{error && <p className="form-inline-error" role="alert">{error}</p>}</> : null }
  const [error, setError] = useState('')
  useToastFeedback(message, error)
  const canManage = organization.role !== 'MEMBER'
  useEffect(() => { setHours(planning.data?.monthlyWorkMinutes ? String(planning.data.monthlyWorkMinutes / 60) : '') }, [planning.data?.monthlyWorkMinutes])
  async function save(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' = 'POST') {
    setBusy(true); setError(''); setMessage(''); setFeedbackScope(path.includes('/positions') ? 'positions' : path.includes('/templates') ? 'templates' : 'workload')
    try { await apiRequest('/organizations/' + organization.id + path, { method, body }); await Promise.all([queryClient.invalidateQueries({ queryKey: ['schedule-planning', organization.id] }), queryClient.invalidateQueries({ queryKey: ['organization-members', organization.id] })]); setMessage(path.includes('/positions') ? 'Должность сохранена' : path.includes('/templates') ? 'Шаблон сохранён' : 'Месячная норма сохранена'); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.'); return false }
    finally { setBusy(false) }
  }
  function editPosition(value: Position | null) { setPosition(value); setName(value?.name ?? '') }
  function editTemplate(value: ShiftTemplate | null) { setTemplate(value); setTemplateName(value?.name ?? ''); setPositionId(value?.positionId ?? ''); setStartTime(value?.startTime ?? '09:00'); setEndTime(value?.endTime ?? '18:00'); setOvernight(Boolean(value?.endDayOffset)) }
  function submitPosition(event: FormEvent) { event.preventDefault(); void save('/schedule/positions' + (position ? '/' + position.id : ''), { name, isActive: position?.isActive ?? true }, position ? 'PATCH' : 'POST').then(saved => { if (saved) editPosition(null) }) }
  function submitTemplate(event: FormEvent) { event.preventDefault(); void save('/schedule/templates' + (template ? '/' + template.id : ''), { name: templateName, positionId: positionId || null, startTime, endTime, endDayOffset: overnight ? 1 : 0, isActive: template?.isActive ?? true }, template ? 'PATCH' : 'POST').then(saved => { if (saved) editTemplate(null) }) }
  if (planning.isLoading) return <article className="settings-card"><p>Загружаем настройки расписания…</p></article>
  if (planning.isError) return <article className="settings-card"><p>Не удалось загрузить настройки расписания.</p><button className="app-secondary" onClick={() => void planning.refetch()}>Повторить</button></article>
  const data = planning.data!
  if (!canManage) return <article className="settings-card"><div><h2>Рабочее время</h2><p>Месячная норма: {data.monthlyWorkMinutes ? data.monthlyWorkMinutes / 60 + ' ч' : 'не задана'}. Должности и шаблоны настраивает администратор.</p></div></article>
  return <article className="planning-settings"><nav className="planning-tabs" aria-label="Настройки расписания">{[['positions', 'Должности'], ['templates', 'Шаблоны смен'], ['workload', 'Норма часов']].map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setMessage(''); setError('') }}>{label}</button>)}</nav>
    {tab === 'workload' && <section><header><h3>Месячная норма часов</h3><p>Порог предупреждения при планировании, общий для сотрудников организации.</p></header>{feedback('workload')}<form onSubmit={event => { event.preventDefault(); void save('/schedule/workload', { monthlyWorkMinutes: hours ? Math.round(Number(hours) * 60) : null }, 'PUT') }}><label><span>Часов на сотрудника в календарный месяц</span><input type="number" min="1" max="744" step="0.5" value={hours} onChange={event => setHours(event.target.value)} placeholder="Норма не задана" /></label><p>В часовом поясе организации. Сумма отработанных и будущих часов; смена относится к месяцу её начала. Превышение требует подтверждения, а не запрещает сохранение.</p><button className="app-primary" disabled={busy}>Сохранить норму</button></form></section>}
    {tab === 'positions' && <section><header><h3>Должности организации</h3><p>Рабочие функции сотрудников. Они не меняют права доступа.</p><Link className="planning-members-link" to={"/app/organizations/" + organization.id + "/employees"}>Назначить должности в разделе «Сотрудники» →</Link></header>{feedback('positions')}<div className="planning-items">{data.positions.map(item => <div key={item.id}><div className="planning-item__identity"><strong>{item.name}</strong><small>{item.isActive ? 'Назначено сотрудникам: ' + data.assignments.filter(assignment => assignment.positionId === item.id).length : 'Неактивная должность'}</small></div><button type="button" className="app-secondary" disabled={busy} onClick={() => editPosition(item)}>Изменить</button><button type="button" className="app-secondary" disabled={busy} onClick={() => void save('/schedule/positions/' + item.id, { name: item.name, isActive: !item.isActive }, 'PATCH')}>{item.isActive ? 'Деактивировать' : 'Восстановить'}</button></div>)}</div><form onSubmit={submitPosition}><label><span>{position ? 'Изменить должность' : 'Новая должность'}</span><input value={name} onChange={event => setName(event.target.value)} minLength={2} maxLength={120} required placeholder="Например, бариста" /></label><div><button className="app-primary" disabled={busy}>Сохранить</button>{position && <button type="button" className="app-secondary" onClick={() => editPosition(null)}>Отмена</button>}</div></form></section>}
    {tab === 'templates' && <section><header><h3>Шаблоны смен</h3><p>Готовое время для должности или всей организации. Сохранённые смены не изменятся.</p></header>{feedback('templates')}<div className="planning-items">{data.templates.map(item => <div key={item.id}><div className="planning-item__identity"><strong>{item.name}</strong><small>{data.positions.find(position => position.id === item.positionId)?.name ?? 'Для всей организации'}{!item.isActive ? ' · Неактивен' : ''}</small></div><span className="planning-item__time">{item.startTime}–{item.endTime}{item.endDayOffset ? ' · следующий день' : ''}</span><button className="app-secondary" disabled={busy} onClick={() => editTemplate(item)}>Изменить</button><button className="app-secondary" disabled={busy} onClick={() => void save('/schedule/templates/' + item.id, { ...item, isActive: !item.isActive }, 'PATCH')}>{item.isActive ? 'Деактивировать' : 'Восстановить'}</button></div>)}</div><form onSubmit={submitTemplate}><label><span>Название шаблона</span><input value={templateName} onChange={event => setTemplateName(event.target.value)} required minLength={2} maxLength={120} /></label><label><span>Для должности</span><Select value={positionId} onChange={event => setPositionId(event.target.value)}><option value="">Общий для организации</option>{data.positions.filter(item => item.isActive).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label><div className="planning-time"><label><span>Начало</span><TimeInput required value={startTime} onChange={event => setStartTime(event.target.value)} /></label><label><span>Окончание</span><TimeInput required value={endTime} onChange={event => setEndTime(event.target.value)} /></label></div><label className="planning-checkbox"><input type="checkbox" checked={overnight} onChange={event => setOvernight(event.target.checked)} /><span>Окончание на следующий день</span></label><div><button className="app-primary" disabled={busy}>Сохранить шаблон</button>{template && <button type="button" className="app-secondary" onClick={() => editTemplate(null)}>Отмена</button>}</div></form></section>}
  </article>
}
