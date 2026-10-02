import Select from '../../component/ui/select/select.tsx'
import { RUSSIAN_TIMEZONES } from '../../app/organizations/russian-timezones.ts'
export type LocationFieldsValue = { name: string; city: string; address: string; timezone: string; teamNames?: string[] }
export default function LocationFields({ value, onChange, disabled = false }: { value: LocationFieldsValue; onChange: (value: LocationFieldsValue) => void; disabled?: boolean }) {
  const set = (field: keyof LocationFieldsValue, text: string) => onChange({ ...value, [field]: text })
  return <div className="organization-profile-fields">
    <label><span>Название точки *</span><input required minLength={2} maxLength={120} disabled={disabled} value={value.name} onChange={e => set('name', e.target.value)} placeholder="Например, Кофейня на Пушкина" /></label>
    <label><span>Город *</span><input required maxLength={120} disabled={disabled} value={value.city} onChange={e => set('city', e.target.value)} placeholder="Москва" /></label>
    <label className="profile-field--wide"><span>Адрес точки *</span><input required minLength={3} maxLength={300} disabled={disabled} value={value.address} onChange={e => set('address', e.target.value)} placeholder="Улица, дом, помещение" /></label>
    <label><span>Часовой пояс точки *</span><Select required disabled={disabled} value={value.timezone} onChange={e => set('timezone', e.target.value)}>{RUSSIAN_TIMEZONES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></label>
  </div>
}
