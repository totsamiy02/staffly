import type { LocationFieldsValue } from './location-fields.tsx'
import { OpeningHoursSummary } from './opening-hours.tsx'
import { formatRussianPhone } from '../../../app/profile/phone.ts'
import { RUSSIAN_TIMEZONES } from '../../../app/organizations/russian-timezones.ts'

export default function LocationProfileDetails({ point }: { point: LocationFieldsValue }) {
  const timezone = RUSSIAN_TIMEZONES.find(item => item.value === point.timezone)?.label ?? point.timezone

  return (
    <div className="location-profile-details">
      <dl className="location-profile-details__facts">
        <div>
          <dt>Формат</dt>
          <dd>{point.kind === 'REMOTE' ? 'Без физического адреса' : 'По адресу'}</dd>
        </div>
        {point.kind !== 'REMOTE' && (
          <>
            <div><dt>Город</dt><dd>{point.city || 'Не указан'}</dd></div>
            <div><dt>Адрес точки</dt><dd>{point.address || 'Не указан'}</dd></div>
          </>
        )}
        <div>
          <dt>Часовой пояс</dt>
          <dd>{timezone}{point.inheritsTimezone ? ' · как у организации' : ''}</dd>
        </div>
        <div>
          <dt>Телефон точки</dt>
          <dd>
            {point.phone ? <a href={'tel:' + point.phone}>{formatRussianPhone(point.phone)}</a> : 'Не указан'}
          </dd>
        </div>
      </dl>
      <section className="location-profile-details__section">
        <h3>Для сотрудников</h3>
        <p>{point.description || 'Описание пока не добавлено.'}</p>
      </section>
      <section className="location-profile-details__section">
        <h3>Часы работы</h3>
        <OpeningHoursSummary value={point.openingHours} />
        <p className="profile-settings-note">Смену за пределами этих часов можно назначить с отдельным подтверждением.</p>
      </section>
    </div>
  )
}
