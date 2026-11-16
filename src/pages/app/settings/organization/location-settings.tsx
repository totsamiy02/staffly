import { MemberBulkAction } from '../../shared/member-bulk-dialog.tsx'
import { AccessIcon } from '../access/access-elements.tsx'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import ProfileDisclosure from '../../organizations/profile-disclosure.tsx'
import LocationProfileDetails from '../../organizations/location-profile-details.tsx'
import { openingHoursSchema } from '../../../../shared/organization-profile.ts'
import { isCompleteRussianPhone } from '../../../../app/profile/phone.ts'
import RequestErrorMessage from '../../../../component/ui/request-error-message.tsx'
import { useFormSafety } from '../../../../app/forms/use-form-safety.ts'
import { canAccess } from '../../../../app/access/catalog.ts'
import { locationTone } from '../../../../app/organizations/format.ts'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../../app/auth/auth-context.tsx'
import { useLocations } from '../../../../app/organizations/queries.ts'
import type { OrganizationLocation, OrganizationSummary } from '../../../../app/organizations/types.ts'
import { useToast } from '../../../../component/ui/toast/toast-context.ts'
import LocationFields, { type LocationFieldsValue } from '../../organizations/location-fields.tsx'
import SensitiveCodeInput from '../../../../component/ui/sensitive-code-input.tsx'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx'
import './location-settings.scss'

export default function LocationSettings({ organization }: { organization: OrganizationSummary }) {
  const subscription = useSubscription()
  const { apiRequest } = useAuth()
  const client = useQueryClient()
  const toast = useToast()
  const points = useLocations(organization.id)
  const owner = organization.organizationRole === 'OWNER' || organization.role === 'OWNER'
  const [pointDialog, setPointDialog] = useState<{ id: string | null; value: LocationFieldsValue } | null>(null)
  const [closing, setClosing] = useState<OrganizationLocation | null>(null)
  const [assigning, setAssigning] = useState<OrganizationLocation | null>(null)
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const safety = useFormSafety({
    scope: 'location:' + organization.id + ':' + (pointDialog?.id ?? 'new'),
    value: pointDialog?.value,
    active: !!pointDialog,
    busy,
  })
  const base = `/organizations/${organization.id}`

  async function refresh() {
    const queryKeys = [
      'locations-overview', 'locations', 'organization', 'organizations', 'organization-members',
      'location-directory', 'schedule-planning', 'documents', 'schedule', 'requests', 'work-time-statistics',
    ]
    await Promise.all(queryKeys.map(key => client.invalidateQueries({ queryKey: [key] })))
  }

  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return false
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
      toast(message)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function savePoint(event: FormEvent) {
    event.preventDefault()
    if (!pointDialog) return
    if (pointDialog.value.openingHours) {
      const valid = openingHoursSchema.safeParse(pointDialog.value.openingHours)
      if (!valid.success) {
        setError(valid.error.issues[0].message)
        return
      }
    }
    if (!isCompleteRussianPhone(pointDialog.value.phone ?? '')) {
      setError('Введите телефон полностью или оставьте поле пустым.')
      return
    }
    const saved = await run(() => apiRequest(`${base}/locations${pointDialog.id ? '/' + pointDialog.id : ''}`, {
      method: pointDialog.id ? 'PATCH' : 'POST',
      body: pointDialog.value,
    }), 'Точка сохранена.')
    if (saved) {
      safety.markSaved()
      setPointDialog(null)
    }
  }

  function createPoint() {
    setError('')
    const current = subscription.subscription
    if (!current || !points.data) {
      setError('Сначала дождитесь загрузки тарифа и точек.')
      return
    }
    const used = points.data.locations.filter(point => !point.archivedAt).length
    if (current.readOnly || used >= current.limits.locations) {
      subscription.request({
        kind: 'locations',
        requiredPlan: current.effectivePlan === 'FREE' ? 'TEAM' : current.effectivePlan === 'TEAM' ? 'BUSINESS' : null,
        message: current.readOnly
          ? 'Срок тарифа завершился. Подключите или продлите его в настройках.'
          : `По текущему тарифу доступно точек: ${current.limits.locations}. Лимит достигнут. Чтобы добавить точку, выберите тариф с большим лимитом.`,
      })
      return
    }
    setPointDialog({
      id: null,
      value: {
        name: '', city: '', address: '',
        timezone: organization.organizationTimezone ?? organization.timezone,
        inheritsTimezone: true,
        kind: 'PHYSICAL',
      },
    })
  }

  async function requestClosingCode() {
    if (!closing) return
    const sent = await run(() => apiRequest(`${base}/locations/${closing.id}/close/request`, {
      method: 'POST', body: {},
    }), 'Код отправлен на почту владельца.')
    if (sent) setCodeSent(true)
  }

  async function closePoint(event: FormEvent) {
    event.preventDefault()
    if (!closing) return
    const saved = await run(() => apiRequest(`${base}/locations/${closing.id}`, {
      method: 'DELETE', body: { code },
    }), 'Точка закрыта.')
    if (saved) setClosing(null)
  }

  const lastPoint = (points.data?.locations.filter(point => !point.archivedAt).length ?? 1) <= 1
  return <div className="location-settings">
    {assigning && <MemberBulkAction organizationId={organization.id} target={{ kind: 'LOCATION', targetId: assigning.id }} onClose={() => setAssigning(null)} onSaved={refresh} />}
    {error && !pointDialog && !closing && <p className="app-alert app-alert--error" role="alert"><RequestErrorMessage error={error}/></p>}
    <article className="settings-card settings-card--list"><header><h2>Точки организации</h2><p>Данные, контакты, часы работы и сотрудники рабочих точек.</p></header>
      {points.isLoading ? (
        <p role="status">Загружаем точки…</p>
      ) : points.isError ? (
        <p role="alert">
          Не удалось загрузить точки.{' '}
          <button className="app-secondary" onClick={() => void points.refetch()}>Повторить</button>
        </p>
      ) : (
        <div className="location-settings-list">
          {points.data?.locations.map(point => (
            <article className="location-settings-item" data-tone={locationTone(point.id)} key={point.id}>
              <div className="location-settings-item__heading">
                <span className="location-mark">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
                    <circle cx="12" cy="10" r="2.5" />
                  </svg>
                </span>
                <div className="location-settings-item__body">
                  <h3>
                    {point.name}
                    {point.id === organization.locationId && <span className="location-current">Выбрана</span>}
                    {point.archivedAt && <span className="location-closed">Закрыта</span>}
                  </h3>
                  <p>
                    {point.kind === 'REMOTE' ? 'Без физического адреса' : [point.city, point.address].filter(Boolean).join(', ') || 'Адрес не указан'}
                  </p>
                  <small>В составе: {point.memberCount}</small>
                </div>
                {(owner || point.permissions?.includes('locations.edit') || point.permissions?.includes('members.assign')) && !point.archivedAt && (
                  <div className="location-actions">
                    {(owner || point.permissions?.includes('members.assign')) && <button type="button" className="app-secondary" disabled={busy} onClick={() => setAssigning(point)}><AccessIcon name="people" />Добавить сотрудников</button>}
                    {(owner || point.permissions?.includes('locations.edit')) && <button className="app-secondary" disabled={busy} onClick={() => {
                      setError('')
                      setPointDialog({
                        id: point.id,
                        value: {
                          name: point.name,
                          city: point.city,
                          address: point.address,
                          timezone: point.timezone,
                          kind: point.kind,
                          phone: point.phone,
                          description: point.description,
                          openingHours: point.openingHours,
                          inheritsTimezone: point.inheritsTimezone,
                          revision: point.revision,
                        },
                      })
                    }}>Изменить</button>}
                    {owner && (
                      <button className="app-secondary" disabled={busy || lastPoint}
                        title={lastPoint ? 'Последнюю действующую точку нельзя закрыть' : 'Закрытие с подтверждением по почте'}
                        onClick={() => {
                          setError('')
                          setCode('')
                          setCodeSent(false)
                          setClosing(point)
                        }}>
                        Закрыть точку
                      </button>
                    )}
                  </div>
                )}
              </div>
              <ProfileDisclosure title="Подробнее о точке">
                <LocationProfileDetails point={point} />
              </ProfileDisclosure>
            </article>
          ))}
        </div>
      )}
      {canAccess(organization, 'locations.create') && (
        <button className="app-primary" onClick={createPoint}>Добавить точку</button>
      )}
    </article>
    {pointDialog && (
      <AnimatedOverlay beforeClose={safety.confirmClose} variant="modal" dismissible={!busy}
        onClose={() => setPointDialog(null)}>
        {close => (
          <DocumentDialog className="location-dialog" eyebrow="Точки организации"
            title={pointDialog.id ? 'Данные точки' : 'Новая точка'} busy={busy} onClose={close}>
            <form onSubmit={savePoint}>
              <LocationFields organizationTimezone={organization.organizationTimezone ?? organization.timezone}
                value={pointDialog.value} disabled={busy}
                onChange={value => setPointDialog({ ...pointDialog, value })} />
              {error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}
              <footer>
                <button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
                <button className="app-primary" disabled={busy}>Сохранить</button>
              </footer>
            </form>
          </DocumentDialog>
        )}
      </AnimatedOverlay>
    )}
    {closing && (
      <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setClosing(null)}>
        {close => (
          <DocumentDialog className="location-dialog" eyebrow="Точки организации" title={`Закрыть «${closing.name}»?`}
            busy={busy} onClose={close}>
            <p>История сохранится. Закрытие подтверждает владелец кодом из письма. Будущие смены, открытые заявки и подмены должны быть обработаны заранее.</p>
            {codeSent ? (
              <form onSubmit={closePoint}>
                <SensitiveCodeInput value={code} onChange={setCode} label="Код закрытия точки из письма" />
                {error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}
                <footer>
                  <button type="button" className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
                  <button className="app-danger" disabled={busy || code.length !== 6}>Закрыть точку</button>
                </footer>
              </form>
            ) : (
              <>
                {error && <p className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></p>}
                <footer>
                  <button className="app-secondary" disabled={busy} onClick={close}>Отмена</button>
                  <button className="app-primary" disabled={busy} onClick={() => void requestClosingCode()}>Получить код</button>
                </footer>
              </>
            )}
          </DocumentDialog>
        )}
      </AnimatedOverlay>
    )}
  </div>
}
