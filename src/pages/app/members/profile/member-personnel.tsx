import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { liveQueryOptions } from '../../../../app/live-query.ts'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import { formatRussianPhone } from '../../../../app/profile/phone.ts'
import { personnelBody, personnelLabels, type PersonnelData, type PersonnelRecord } from '../../../../shared/member-personnel.ts'
import { ProfileDetails } from '../../settings/shared/profile-settings.tsx'
import { AccessIcon } from '../../settings/access/access-elements.tsx'
import ChangeTimeline from '../../../../component/ui/change-timeline/change-timeline.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import RequestErrorMessage from '../../../../component/ui/request-error-message.tsx'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import './member-personnel.scss'

type PersonnelField = keyof typeof personnelLabels
type EditorMode = 'personnel' | 'contacts'
type MemberPersonnelProps = {
  organizationId: string
  memberId: string
  locationId: string
  own: boolean
}

export default function MemberPersonnel({ organizationId, memberId, locationId, own }: MemberPersonnelProps) {
  const { apiRequest, user } = useAuth()
  const client = useQueryClient()
  const [historyPage, setHistoryPage] = useState<number>()
  const [editing, setEditing] = useState<EditorMode>()
  const endpoint = '/organizations/' + organizationId + '/members/' + memberId + '/personnel?locationId=' + locationId
  const query = useQuery({
    ...liveQueryOptions,
    queryKey: ['member-personnel', organizationId, user?.id, memberId, locationId, historyPage],
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey
      const sameCard = previousKey?.[1] === organizationId && previousKey?.[2] === user?.id
        && previousKey?.[3] === memberId && previousKey?.[4] === locationId
      return sameCard ? previous : undefined
    },
    queryFn: () => apiRequest<PersonnelData>(endpoint + (historyPage ? '&historyPage=' + historyPage : '')),
  })
  const data = query.data

  if (query.isPending) {
    return (
      <section className="member-profile-block member-personnel member-personnel--loading" role="status">
        <span className="app-spinner" /><p>Загружаем карточку…</p>
      </section>
    )
  }
  if (query.isError || !data) {
    return (
      <section className="member-profile-block member-personnel member-personnel--loading" role="alert">
        <RequestErrorMessage error={query.error} />
        <button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button>
      </section>
    )
  }
  if (!data.record) return null

  const record = data.record
  const filled = (Object.keys(personnelLabels) as PersonnelField[]).some(key => !!record[key])
  const name = [record.personnelLastName, record.personnelFirstName, record.personnelMiddleName].filter(Boolean).join(' ')
  const canEdit = data.capabilities.edit || data.capabilities.contacts
  const history = data.history

  async function handleSaved() {
    setEditing(undefined)
    const queryKeys = ['member-personnel', 'member-profile', 'organization-members', 'location-directory', 'members', 'former-members']
    await Promise.all(queryKeys.map(key => client.invalidateQueries({ queryKey: [key] })))
  }

  return (
    <section className="member-profile-block member-personnel" aria-label="Кадровые сведения">
      <header className="member-personnel__heading">
        <span className="member-personnel__icon"><AccessIcon name="briefcase" /></span>
        <div><h3>Кадровые сведения</h3><p>Профиль сотрудника в организации</p></div>
        {canEdit && (
          <button className="app-secondary" onClick={() => setEditing(data.capabilities.edit ? 'personnel' : 'contacts')}>
            <AccessIcon name="edit" />
            {data.capabilities.edit ? 'Изменить сведения' : 'Изменить мои рабочие контакты'}
          </button>
        )}
      </header>
      {filled ? (
        <div className="member-personnel__body">
          <ProfileDetails items={[
            { label: 'Кадровое ФИО', value: name },
            { label: 'Табельный номер', value: record.personnelNumber },
            { label: 'Рабочая почта', value: record.workEmail ? <a href={'mailto:' + record.workEmail}>{record.workEmail}</a> : null },
            { label: 'Рабочий телефон', value: record.workPhone ? <a href={'tel:' + record.workPhone}>{formatRussianPhone(record.workPhone)}</a> : null },
          ]} />
        </div>
      ) : (
        <div className="member-personnel__empty">
          <span><AccessIcon name="briefcase" /></span>
          <div>
            <strong>Карточка пока не заполнена</strong>
            <p>{data.capabilities.edit
              ? 'Добавьте кадровое имя, номер и рабочие контакты.'
              : 'Кадровые данные заполнит уполномоченный сотрудник. Вы можете добавить свои рабочие контакты.'}</p>
          </div>
        </div>
      )}
      {own && (
        <Link className="member-personnel__account-link" to="/app/settings">
          <AccessIcon name="info" /><span>Личные данные и контакты аккаунта</span><AccessIcon name="chevron" />
        </Link>
      )}
      {data.capabilities.history && (
        <div className="member-personnel__history">
          <button className="member-personnel__history-toggle" aria-expanded={!!historyPage}
            onClick={() => setHistoryPage(historyPage ? undefined : 1)}>
            <AccessIcon name="history" /><span>История кадровых изменений</span><AccessIcon name="chevron" />
          </button>
          {historyPage && (
            <div className="member-personnel-history">
              {query.isPlaceholderData || !history ? (
                <p className="member-personnel__history-empty" role="status">Загружаем изменения…</p>
              ) : history.items.length ? (
                <ChangeTimeline items={history.items} labels={personnelLabels} />
              ) : (
                <p className="member-personnel__history-empty">Здесь появятся сохранённые изменения карточки.</p>
              )}
              {history && history.pages > 1 && (
                <nav aria-label="Страницы кадровой истории">
                  <button className="app-secondary" disabled={historyPage === 1}
                    onClick={() => setHistoryPage(page => (page ?? 1) - 1)}>Назад</button>
                  <span>{historyPage} / {history.pages}</span>
                  <button className="app-secondary" disabled={historyPage === history.pages}
                    onClick={() => setHistoryPage(page => (page ?? 1) + 1)}>Далее</button>
                </nav>
              )}
            </div>
          )}
        </div>
      )}
      {editing && (
        <PersonnelEditor record={record} mode={editing} endpoint={endpoint}
          scope={organizationId + ':' + memberId + ':' + locationId}
          onClose={() => { setEditing(undefined); void query.refetch() }} onSaved={handleSaved} />
      )}
    </section>
  )
}

type PersonnelEditorProps = {
  record: PersonnelRecord
  mode: EditorMode
  endpoint: string
  scope: string
  onClose: () => void
  onSaved: () => Promise<void>
}

function PersonnelEditor({ record, mode, endpoint, scope, onClose, onSaved }: PersonnelEditorProps) {
  const [value, setValue] = useState(() => Object.fromEntries(
    Object.keys(personnelLabels).map(key => [key, record[key as PersonnelField] ?? '']),
  ) as Record<PersonnelField, string>)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const { apiRequest } = useAuth()
  const toast = useToast()
  // The open editor must keep its original revision across live query refreshes.
  const [revision] = useState(record.personnelRevision)
  const safety = useFormSafety({ scope: 'member-personnel:' + scope, value, busy, active: true })
  const fields = (Object.keys(personnelLabels) as PersonnelField[])
    .filter(key => mode === 'personnel' || key === 'workEmail' || key === 'workPhone')

  async function save() {
    const parsed = personnelBody.safeParse({
      mode,
      revision,
      ...Object.fromEntries(fields.map(key => [key, value[key]])),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await apiRequest(endpoint, { method: 'PATCH', body: parsed.data })
      safety.markSaved()
      toast('Карточка сотрудника сохранена.', 'success')
      await onSaved()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  function renderField(key: PersonnelField) {
    const required = key === 'personnelFirstName' || key === 'personnelLastName'
    const type = key === 'workEmail' ? 'email' : key === 'workPhone' ? 'tel' : 'text'
    const maxLength = key === 'workEmail' ? 254 : key === 'workPhone' ? 18 : key === 'personnelNumber' ? 32 : 80
    return (
      <label key={key}>
        <span>{personnelLabels[key]}{required ? ' *' : ''}</span>
        <input type={type} required={required} maxLength={maxLength} disabled={busy}
          value={key === 'workPhone' ? formatRussianPhone(value[key]) : value[key]}
          onChange={event => setValue(previous => ({ ...previous, [key]: event.target.value }))} />
      </label>
    )
  }

  return (
    <AnimatedOverlay variant="modal" className="member-personnel-overlay" beforeClose={safety.confirmClose}
      dismissible={!busy} onClose={onClose}>
      {close => (
        <DocumentDialog title={mode === 'personnel' ? 'Кадровые сведения' : 'Мои рабочие контакты'}
          className="members-dialog member-personnel-editor" busy={busy} onClose={close} onEscape={close} eyebrow="Сотрудники">
          <form className="member-personnel-form" onSubmit={event => { event.preventDefault(); if (!busy) void save() }}>
            <p className="member-personnel-form__intro">Изменения сохранятся только в этой организации.</p>
            {mode === 'personnel' && (
              <fieldset className="member-personnel-form__section" disabled={busy}>
                <legend><AccessIcon name="briefcase" />Данные сотрудника</legend>
                <div className="member-personnel-form__grid">
                  {(['personnelLastName', 'personnelFirstName', 'personnelMiddleName', 'personnelNumber'] as const).map(renderField)}
                </div>
                <p>* Фамилия и имя обязательны. Номер должен быть уникальным в организации.</p>
              </fieldset>
            )}
            <fieldset className="member-personnel-form__section" disabled={busy}>
              <legend><AccessIcon name="info" />Рабочие контакты</legend>
              <div className="member-personnel-form__grid">{renderField('workEmail')}{renderField('workPhone')}</div>
              <p>Личная почта и телефон аккаунта остаются в настройках профиля.</p>
            </fieldset>
            {!!error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}
            <footer>
              <button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
              <button className="app-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            </footer>
          </form>
        </DocumentDialog>
      )}
    </AnimatedOverlay>
  )
}
