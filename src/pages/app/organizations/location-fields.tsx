import Select from '../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { RUSSIAN_TIMEZONES } from '../../../app/organizations/russian-timezones.ts'
import { formatRussianPhone } from '../../../app/profile/phone.ts'
import type { LocationProfile } from '../../../shared/organization-profile.ts'
import ProfileDisclosure from './profile-disclosure.tsx'
import OpeningHoursEditor from './opening-hours.tsx'
export type LocationFieldsValue = {name:string;city:string;address:string;timezone:string;teamNames?:string[]} & LocationProfile
export default function LocationFields({value,onChange,disabled=false,organizationTimezone,part='all'}:{value:LocationFieldsValue;onChange:(value:LocationFieldsValue)=>void;disabled?:boolean;organizationTimezone?:string;part?:'all'|'main'|'additional'}){
 const set=(field:keyof LocationFieldsValue,text:string)=>onChange({...value,[field]:text})
 return <div className="organization-profile-fields">
 {part!=='additional'&&<>
 <label className="profile-field--wide"><span>Название точки *</span><input required minLength={2} maxLength={120} disabled={disabled} value={value.name} onChange={e=>set('name',e.target.value)} placeholder="Например, Основная точка"/></label>
 <div className="profile-field--wide"><p className="profile-field-label">Формат точки</p><SegmentedNav label="Формат точки">{[['PHYSICAL','По адресу'],['REMOTE','Удалённо']].map(([kind,label])=><button key={kind} type="button" disabled={disabled} aria-pressed={(value.kind??'PHYSICAL')===kind} onClick={()=>onChange({...value,kind:kind as 'PHYSICAL'|'REMOTE'})}>{label}</button>)}</SegmentedNav></div>
 {value.kind==='REMOTE'?<p className="profile-field--wide profile-settings-note">Физический адрес не требуется.</p>:<><label><span>Город *</span><input required maxLength={120} disabled={disabled} value={value.city} onChange={e=>set('city',e.target.value)} placeholder="Укажите город"/></label><label><span>Адрес точки *</span><input required minLength={3} maxLength={300} disabled={disabled} value={value.address} onChange={e=>set('address',e.target.value)} placeholder="Улица, дом, помещение"/></label></>}
 <label className="profile-field--wide"><span>Часовой пояс точки *</span><Select required disabled={disabled||value.inheritsTimezone} value={value.inheritsTimezone&&organizationTimezone?organizationTimezone:value.timezone} onChange={e=>set('timezone',e.target.value)}>{RUSSIAN_TIMEZONES.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</Select></label>
 {organizationTimezone&&<label className="profile-field--wide profile-check"><input type="checkbox" checked={value.inheritsTimezone??false} disabled={disabled} onChange={e=>onChange({...value,inheritsTimezone:e.target.checked,timezone:e.target.checked?organizationTimezone:value.timezone})}/><span>Использовать часовой пояс организации</span></label>}
 </>}
 {part!=='main'&&<>
 <div className="profile-field--wide"><ProfileDisclosure title="Подробнее о точке" initiallyOpen={!!(value.phone||value.description)}><label><span>Телефон точки</span><input type="tel" maxLength={18} disabled={disabled} value={formatRussianPhone(value.phone??'')} onChange={e=>set('phone',formatRussianPhone(e.target.value))} placeholder="Необязательно"/></label><label><span>Описание для сотрудников</span><textarea rows={3} maxLength={1000} disabled={disabled} value={value.description??''} onChange={e=>set('description',e.target.value)} placeholder="Информация о входе, проезде и работе точки"/></label></ProfileDisclosure></div>
 <div className="profile-field--wide"><ProfileDisclosure title="Часы работы" initiallyOpen={!!value.openingHours}><OpeningHoursEditor value={value.openingHours} disabled={disabled} onChange={openingHours=>onChange({...value,openingHours})}/></ProfileDisclosure></div>
 </>}
 </div>
}
