import FormDraftNotice from '../../../component/ui/form-draft-notice.tsx'
import { useFormSafety } from '../../../app/forms/use-form-safety.ts'
import { isPlanId } from '../../../app/subscriptions/plans.ts'
import LocationFields, { type LocationFieldsValue } from './location-fields.tsx'
import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import AppTopbar from '../topbar/app-topbar.tsx'
import Select from '../../../component/ui/select/select.tsx'
import ImageUpload from '../../../component/ui/image-upload/image-upload.tsx'
import { useImageDraft } from '../../../component/ui/image-upload/use-image-draft.ts'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import ProfileDisclosure from './profile-disclosure.tsx'
import { formatRussianPhone, isCompleteRussianPhone } from '../../../app/profile/phone.ts'
import { openingHoursSchema } from '../../../shared/organization-profile.ts'
import { RUSSIAN_TIMEZONES, russianTimezoneOrMoscow } from '../../../app/organizations/russian-timezones.ts'
import '../app.scss'
import './organization-profile.scss'

export default function CreateOrganizationPage(){
 const {apiRequest}=useAuth(),queryClient=useQueryClient(),navigate=useNavigate()
 const selectedPlan=new URLSearchParams(window.location.search).get('plan')
 const detected=russianTimezoneOrMoscow(Intl.DateTimeFormat().resolvedOptions().timeZone)
 const [form,setForm]=useState({name:'',description:'',industry:'',timezone:detected,contactEmail:'',phone:'',website:'',address:''})
 const [point,setPoint]=useState<LocationFieldsValue>({name:'Основная точка',city:'',address:'',timezone:detected,inheritsTimezone:true,kind:'PHYSICAL'})
 const [creationKey,setCreationKey]=useState(()=>crypto.randomUUID()),[error,setError]=useState<unknown>(null),[imageBusy,setImageBusy]=useState(false)
 const logo=useImageDraft('/organization-logos',null),sent=useRef<Record<string,unknown>|null>(null)
 const create=useMutation({mutationFn:async()=>{
   if(!sent.current){if(point.openingHours){const checked=openingHoursSchema.safeParse(point.openingHours);if(!checked.success)throw new Error(checked.error.issues[0].message);}if(!isCompleteRussianPhone(form.phone)||!isCompleteRussianPhone(point.phone??''))throw new Error('Введите телефон полностью или оставьте поле пустым.');const logoUploadId=await logo.prepare();sent.current={...form,firstLocation:{...point,timezone:point.inheritsTimezone?form.timezone:point.timezone},initialPlan:'FREE',creationKey,logoUploadId}}
   return apiRequest<{organization:OrganizationSummary}>('/organizations',{method:'POST',body:sent.current})
 },onSuccess:async result=>{await queryClient.invalidateQueries({queryKey:['organizations']});safety.markSaved();navigate(`/app/organizations/${result.organization.id}/settings?${isPlanId(selectedPlan)&&selectedPlan!=='FREE'?`section=subscription&plan=${selectedPlan}`:'section=profile'}`,{replace:true})},onError:failure=>{if([400,413,415,422].includes((failure as {status?:number}).status??0))sent.current=null;setError(failure)}})
 const safety=useFormSafety({scope:'create-organization',value:{form,point,creationKey},busy:create.isPending||imageBusy,draft:true,extraDirty:logo.dirty,onRestore:value=>{setForm(value.form);setPoint(value.point);setCreationKey(value.creationKey)}})
 const field=(key:keyof typeof form,value:string)=>setForm(previous=>({...previous,[key]:value}))
 const disabled=create.isPending||imageBusy||!!sent.current
 function submit(event:FormEvent){event.preventDefault();if(create.isPending)return;setError(null);create.mutate()}
 return <div className="app-page"><AppTopbar/><main className="organization-create-layout"><Link className="app-back" to="/app">К организациям</Link><div className="organization-form-page__intro"><p className="app-eyebrow">Новое рабочее пространство</p><h1>Создание организации</h1><p>Заполните профиль и добавьте первую точку. Остальное можно изменить позже.</p></div><FormDraftNotice form={safety}/>
 <form className="organization-form organization-create-form" onSubmit={submit}>
 <fieldset className="organization-create-card" disabled={disabled}><h2>Об организации</h2><ImageUpload draftHint="Логотип сохранится при создании организации." endpoint="/organization-logos" imageUrl={logo.url} onDraftChange={logo.change} name={form.name||'Организация'} avatarClassName="organization-create-logo" disabled={disabled} onBusyChange={setImageBusy} onChange={()=>{}} onMessage={()=>{}} onError={setError}/>
 <label><span>Название организации *</span><input required minLength={2} maxLength={120} autoFocus value={form.name} onChange={e=>field('name',e.target.value)} placeholder="Название"/></label><label><span>Описание</span><textarea aria-label="Описание" rows={3} maxLength={1000} value={form.description} onChange={e=>field('description',e.target.value)} placeholder="Чем занимается организация"/><small>{form.description.length}/1000</small></label><label><span>Сфера деятельности</span><input maxLength={120} value={form.industry} onChange={e=>field('industry',e.target.value)} placeholder="Например, общественное питание"/></label><label><span>Часовой пояс организации *</span><Select required value={form.timezone} onChange={e=>field('timezone',e.target.value)}>{RUSSIAN_TIMEZONES.map(item=><option value={item.value} key={item.value}>{item.label}</option>)}</Select></label>
</fieldset>
 <fieldset className="organization-create-card" disabled={disabled}><h2>Первая точка</h2><LocationFields part="main" value={point} onChange={setPoint} disabled={disabled} organizationTimezone={form.timezone}/></fieldset>
 <fieldset className="organization-create-card organization-create-additional" disabled={disabled}><h2>Дополнительные сведения</h2><p className="profile-settings-note">Необязательно. Можно заполнить сейчас или позже в настройках организации и точки.</p><div className="organization-create-additional__grid"><section><h3>Организация</h3> <ProfileDisclosure title="Контакты и адрес"><label><span>Рабочая почта</span><input type="email" maxLength={254} value={form.contactEmail} onChange={e=>field('contactEmail',e.target.value)} placeholder="Необязательно"/></label><label><span>Телефон</span><input type="tel" maxLength={18} value={form.phone} onChange={e=>field('phone',formatRussianPhone(e.target.value))} placeholder="Необязательно"/></label><label><span>Сайт</span><input type="url" maxLength={2048} value={form.website} onChange={e=>field('website',e.target.value)} placeholder="https://"/></label><label><span>Адрес организации</span><input maxLength={300} value={form.address} onChange={e=>field('address',e.target.value)} placeholder="Необязательно"/></label></ProfileDisclosure></section><section><h3>Первая точка</h3><LocationFields part="additional" value={point} onChange={setPoint} disabled={disabled} organizationTimezone={form.timezone}/></section></div></fieldset>
 <footer className="organization-create-footer"><small>* Обязательные поля. Стартовый тариф — Бесплатный.</small><small>Сведения доступны участникам организации. Контактные данные не публикуются на сайте автоматически.</small>{!!error&&<div className="app-alert app-alert--error" role="alert"><RequestErrorMessage error={error}/>{sent.current&&<p>Запрос уже отправлен. Повтор сохранит ту же организацию. Перед новым созданием проверьте <Link to="/app">мои организации</Link>.</p>}</div>}<div className="organization-form__actions"><Link className="app-secondary" to="/app">{sent.current?'Мои организации':'Отмена'}</Link><button className="app-primary" disabled={create.isPending||imageBusy}>{create.isPending?'Создаём…':sent.current?'Повторить создание':'Создать организацию'}</button></div></footer>
 </form></main></div>
}
