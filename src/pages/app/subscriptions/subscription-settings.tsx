import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import DocumentDialog from '../../../component/ui/modal/document-dialog.tsx'
import RequestErrorMessage from '../../../component/ui/request-error-message.tsx'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import { plans, isPlanId, nextMonth, type PlanId } from '../../../app/subscriptions/plans.ts'
import { sizeLabel } from '../../../app/documents/types.ts'
import { PlanCards, PlanIcon } from './plan-ui.tsx'
import { useSubscriptionDetails, useSubscriptionRefresh, type SubscriptionDetails } from '../../../app/subscriptions/queries.ts'
const phases = {trial:'Ранее выданный пробный доступ',active:'Доступ действует',free:'Без срока окончания',grace:'Льготный период',expired:'Доступ завершился'}
export default function SubscriptionSettings({ organization }: { organization: OrganizationSummary }) {
  const query=useSubscriptionDetails(organization.id),refresh=useSubscriptionRefresh(),{apiRequest}=useAuth()
  const [selection,setSelection]=useState<{plan:PlanId;revision:number;renewUntil:string|null;replaces:boolean}|null>(null),[params,setParams]=useSearchParams()
  const select=useMutation({mutationFn:()=>apiRequest(`/organizations/${organization.id}/subscription/select`,{method:'POST',body:{plan:selection!.plan,revision:selection!.revision,confirm:true}}),onSuccess:async()=>{setSelection(null);await refresh()}})
  const resetSelection=select.reset
  const choose=(plan:PlanId)=>{if(!query.data)return;resetSelection();setSelection(selectionFor(query.data,plan))}
  const requested=params.get('plan')
  useEffect(()=>{if(!query.data||!requested)return;if(query.data.canManage&&isPlanId(requested)){resetSelection();setSelection(selectionFor(query.data,requested))}setParams(previous=>{const next=new URLSearchParams(previous);next.delete('plan');return next},{replace:true})},[query.data,requested,setParams,resetSelection])
  if(query.isPending)return <div className="app-state" role="status">Загружаем тариф…</div>
  if(!query.data)return <div className="app-state" role="alert"><p>{query.error?.message??'Не удалось загрузить тариф.'}</p><button className="app-secondary" onClick={()=>void query.refetch()}>Повторить</button></div>
  const {subscription:sub,usage}=query.data,selected=plans[sub.effectivePlan]
  return <div className="subscription-settings"><div className="subscription-section-heading"><div><h2>Тариф и использование</h2><p>Staffly работает без оплаты. Новые организации начинают с Бесплатного тарифа. Владелец каждой организации может выбрать и подключить тариф здесь, без оплаты.</p></div></div>
    <article className="subscription-current"><div className="subscription-current__heading"><PlanIcon plan={sub.effectivePlan}/><div><h3>{selected.name}</h3><p>Для «{organization.name}»</p></div><div className="subscription-current__status"><strong>{phases[sub.phase]}</strong>{sub.validUntil&&<small>До {new Date(sub.validUntil).toLocaleDateString('ru-RU')}</small>}</div></div>
      <div className="subscription-usage">{[{label:'Участники',used:usage.members,limit:sub.limits.members,text:`${usage.members} / ${sub.limits.members}`},{label:'Точки',used:usage.locations,limit:sub.limits.locations,text:`${usage.locations} / ${sub.limits.locations}`},{label:'Хранилище',used:usage.storageBytes,limit:sub.limits.storageBytes,text:`${sizeLabel(usage.storageBytes)} / ${sizeLabel(sub.limits.storageBytes)}`}].map(item=><div key={item.label}><div><strong>{item.label}</strong><span>{item.text}</span></div><progress value={Math.min(item.used,item.limit)} max={item.limit} aria-label={item.label}/></div>)}</div>
      <small>Участник в нескольких точках занимает одно место. Бывшие сотрудники не занимают места. Серверные квоты сохраняются.</small>
    </article>
    {sub.supportAccess&&<p className="subscription-banner">{sub.supportAccess.active?'Доступ выдан администратором сервиса':'Назначенный администратором доступ сейчас не действует'}: {plans[sub.supportAccess.plan].name}, {new Date(sub.supportAccess.startsAt).toLocaleDateString('ru-RU')} — {new Date(sub.supportAccess.endsAt).toLocaleDateString('ru-RU')}.</p>}
    {sub.scheduled&&<p className="subscription-banner">Сохранённое изменение: с {new Date(sub.scheduled.startsAt).toLocaleDateString('ru-RU')} — {plans[sub.scheduled.plan].name}. Новый выбор заменит это изменение.</p>}
    <p>Тариф выбирает владелец организации. Команда и Бизнес подключаются на месяц и продлеваются вручную. Банковские реквизиты не требуются, списания и автопродление не выполняются.</p>
    {!query.data.canManage&&<p>Подключить или продлить тариф может только владелец организации.</p>}
    <PlanCards current={sub.effectivePlan==='FREE'&&(sub.phase!=='free'||sub.supportAccess||sub.scheduled)?undefined:sub.effectivePlan} onChoose={query.data.canManage?choose:undefined} busy={select.isPending}/>
    {selection&&<AnimatedOverlay variant="modal" dismissible={!select.isPending} onClose={()=>setSelection(null)}>{close=><DocumentDialog title={selection.plan==='FREE'?'Выбрать Бесплатный тариф?':selection.renewUntil?'Продлить тариф без оплаты?':'Подключить тариф без оплаты?'} eyebrow="Тариф организации" onClose={close} busy={select.isPending}>
      <p>Для «{organization.name}» — <strong>{plans[selection.plan].name}</strong>.</p>
      <p>{plans[selection.plan].members} участников · {plans[selection.plan].locations} точек · {plans[selection.plan].storageLabel} хранилища.</p>
      <p>{selection.plan==='FREE'?'Бесплатный тариф действует без срока окончания.':selection.renewUntil?`Доступ будет продлён до ${selection.renewUntil}.`:'Доступ включится сразу на один месяц. Продление — вручную.'} Карта не требуется, деньги не списываются.</p>
      {selection.replaces&&<p>Выбор заменит временное назначение администратора и отложенное изменение тарифа.</p>}
      <p>При переходе на меньший тариф текущие участники, точки и файлы должны укладываться в его лимиты. Данные не удаляются.</p>
      {select.error&&<div role="alert"><RequestErrorMessage error={select.error}/><button type="button" className="app-secondary" disabled={select.isPending} onClick={()=>{setSelection(null);void refresh()}}>Обновить условия</button></div>}
      <footer><button className="app-secondary" disabled={select.isPending} onClick={close}>Отмена</button><button className="app-primary" disabled={select.isPending} onClick={()=>{if(!select.isPending)select.mutate()}}>{select.isPending?'Подключаем…':'Подтвердить без оплаты'}</button></footer>
    </DocumentDialog>}</AnimatedOverlay>}

  </div>
}

function selectionFor(data:SubscriptionDetails,plan:PlanId){const sub=data.subscription;return {plan,revision:data.revision,renewUntil:plan!=='FREE'&&sub.effectivePlan===plan&&sub.phase==='active'&&sub.validUntil&&!sub.supportAccess&&!sub.scheduled?nextMonth(new Date(sub.validUntil)).toLocaleDateString('ru-RU'):null,replaces:!!(sub.supportAccess||sub.scheduled)}}
