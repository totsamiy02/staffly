import type { ReactNode } from 'react'
import type { AvailabilityRule, AvailabilityWarning } from '../../../../shared/availability.ts'
import { displayDate } from '../../../../app/schedule/date-utils.ts'
import Select from '../../../../component/ui/select/select.tsx'
import { TimeInput } from '../../../../component/ui/date-picker/date-picker.tsx'
import './availability.scss'

export function AvailabilityIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
}

export function AvailabilityFooter({ onClose, action, busy = false, disabled = false, onSave, note }: {
  onClose: () => void
  action?: string
  busy?: boolean
  disabled?: boolean
  onSave?: () => void
  note?: ReactNode
}) {
  return <footer className="availability-footer">
    {note && <small>{note}</small>}
    <div>
      <button type="button" className="app-secondary" disabled={busy} onClick={onClose}>{onSave ? 'Отмена' : 'Закрыть'}</button>
      {onSave && <button type="button" className="app-primary" disabled={busy || disabled} onClick={onSave}>
        {busy ? 'Сохраняем…' : action ?? 'Сохранить доступность'}
      </button>}
    </div>
  </footer>
}

export function RuleEditor({ label, rule, onChange, disabled = false }: {
  label: string
  rule: AvailabilityRule
  onChange: (rule: AvailabilityRule) => void
  disabled?: boolean
}) {
  return <div className={`availability-week-row${rule.mode === 'OFF' ? ' is-off' : ''}`}>
    <strong>{label}</strong>
    <Select aria-label={`${label}: доступность`} value={rule.mode} disabled={disabled} onChange={event => {
      const mode = event.target.value
      onChange(mode === 'TIME' ? { mode, start: '09:00', end: '18:00', overnight: false } : { mode: mode === 'OFF' ? 'OFF' : 'ANY' })
    }}>
      <option value="ANY">Без ограничений</option>
      <option value="TIME">Указать время</option>
      <option value="OFF">Недоступен</option>
    </Select>
    {rule.mode === 'TIME' ? <div className="availability-week-time">
      <TimeInput aria-label={`${label}: с`} value={rule.start} disabled={disabled} onChange={event => onChange({ ...rule, start: event.target.value })} />
      <span>—</span>
      <TimeInput aria-label={`${label}: до`} value={rule.end} disabled={disabled} onChange={event => onChange({ ...rule, end: event.target.value })} />
      <label title="Окончание на следующий день">
        <input type="checkbox" aria-label={`${label}: следующий день`} checked={rule.overnight} disabled={disabled} onChange={event => onChange({ ...rule, overnight: event.target.checked })} />
        <span>+1 день</span>
      </label>
    </div> : <p>{rule.mode === 'OFF' ? 'Весь день' : 'Ограничения не заданы'}</p>}
  </div>
}

export function AvailabilityWarningPanel({ warning, agreed, reason, onAgree, onReason }: {
  warning: AvailabilityWarning
  agreed: boolean
  reason: string
  onAgree: () => void
  onReason: (reason: string) => void
}) {
  return <section className={`availability-shift-warning${agreed ? ' is-agreed' : ''}`} aria-label="Проверка доступности">
    <AvailabilityIcon />
    <div>
      <strong>{agreed ? 'Назначение по договорённости' : `Вне доступности: ${warning.availabilityConflicts.length}`}</strong>
      <ul>{warning.availabilityConflicts.map((issue, index) => <li key={`${issue.memberId}:${issue.start}:${index}`}>
        {displayDate(issue.date)} · {issue.message} · {issue.timezone}
      </li>)}</ul>
      {agreed ? <label>
        <span>Причина назначения</span>
        <textarea aria-label="Причина назначения" name="availabilityReason" value={reason} onChange={event => onReason(event.target.value)} rows={2} maxLength={500} minLength={3} required />
        <small>Причина и автор сохранятся в истории смены.</small>
      </label> : warning.canOverrideAvailability ? <div className="availability-warning-actions">
        <button type="button" className="app-secondary" onClick={onAgree}>Назначить по договорённости</button>
      </div> : <p>Измените время или выберите другого сотрудника. Для назначения по договорённости нужны соответствующие права.</p>}
    </div>
  </section>
}
