import AdminPopover from '../admin-popover.tsx'
import AdminDisclosure from '../admin-disclosure.tsx'
import { useSearchParams } from 'react-router-dom'
import CopyReference from '../../../component/ui/copy-reference.tsx'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'
import { useAdminData } from '../admin-data.tsx'
import { AdminBadge,Empty,Pagination,Panel,Stat,count,date } from '../admin-elements.tsx'
import { Loading } from '../admin-feedback.tsx'
import AdminTabs from '../admin-tabs.tsx'
import AdminTable from '../admin-table.tsx'
import { OperationsToolbar,KeyValues } from '../operations/elements.tsx'
import { Frame,useAction } from './shared.tsx'
import { auditLabels } from './catalog.ts'
import type { SecurityState } from './contracts.ts'
export default function SecurityPage(){
 const [params,setParams]=useSearchParams(),view=params.get('view')==='journal'?'journal':'sessions'
 const {data,error,refresh,readState}=useAdminData<SecurityState>('/management/security?'+params),action=useAction(refresh)
 if(!data)return <Loading error={error} retry={refresh}/>
 return <Frame title="Безопасность" error={error} refresh={refresh} readState={readState}>{action.feedback}
  <div className="admin-stats"><Stat label="Администраторы" value={count(data.summary.administrators)} icon="shield"/><Stat label="Сеансы панели" value={count(data.summary.sessions)} icon="key"/><Stat label="Отказы за сутки" value={count(data.summary.denials)} icon="lock"/><Stat label="Автоблокировка" value="5 мин" icon="clock"/></div>
  <AdminDisclosure className="admin-security-policy" label={<>Политика доступа и защиты</>}><KeyValues items={[["Вход",'Пароль аккаунта + код из почты'],['PIN',`${data.policy.pinDigits} цифр · ${data.policy.pinAttempts} попыток`],['Почтовый код',`${data.policy.codeSeconds/60} минут · одно использование`],['Сеанс панели',`Не более ${data.policy.absoluteSeconds/3600} часов`],['Критические действия','Повторный пароль и отдельный почтовый код'],['Cookie',data.policy.secureCookies?'HttpOnly · Secure · SameSite=Strict':'HttpOnly · SameSite=Strict (тестовый контур)'],['Хранение журнала',`${data.policy.auditDays} дней`],['Отзыв доступа','Завершает все административные сеансы']]}/></AdminDisclosure>
  <AdminTabs label="Раздел безопасности" value={view} items={[["sessions","Сеансы"],["journal","Журнал"]]} onChange={next=>{const q=new URLSearchParams(params);q.set('view',next);setParams(q)}}/>
  {view==='sessions'?<section role="tabpanel" aria-label="Сеансы"><OperationsToolbar hidePeriod searchKey="sessionSearch" pageKey="sessionPage" label="Поиск административных сеансов" placeholder="Администратор, его номер или ID сеанса" filters={[{key:'sessionState',label:'Состояние сеанса',options:{all:'Все состояния',active:'Активен',locked:'Заблокирован',setup:'Создание PIN'}}]}/>
   <Panel title="Сеансы администрирования" subtitle={`Найдено ${data.sessionTotal} из ${data.summary.sessions} действующих сеансов`}><AdminTable primary={[0,1,2]} actions={[4]}><table><thead><tr><th>Администратор</th><th>Состояние</th><th>Активность · МСК</th><th>Истекает · МСК</th><th>Действие</th></tr></thead><tbody>{data.sessions.map(session=><tr key={session.id}><td><strong>{session.name}{session.current?' · этот сеанс':''}</strong><AdminPopover label="ID сеанса"><SupportReference value={session.id} label="ID сеанса"/></AdminPopover></td><td><AdminBadge tone={session.state==='active'?'green':'gray'}>{session.state==='active'?'Активен':session.state==='locked'?'Заблокирован':'Создание PIN'}</AdminBadge></td><td>{date(session.activityAt,true)}</td><td>{date(session.expiresAt,true)}</td><td><button className="admin-btn" disabled={session.current} onClick={()=>action.open({spec:{action:'SESSION_REVOKE',targetId:session.id,payload:{version:session.version}},description:`Завершить сеанс ${session.name} (${session.id}). В завершённом сеансе потребуется новый административный вход.`})}>Завершить сеанс</button></td></tr>)}</tbody></table>{!data.sessions.length&&<Empty>Сеансы по этим условиям не найдены.</Empty>}</AdminTable><Pagination total={data.sessionTotal} page={data.sessionPage} pageSize={data.sessionPageSize} pageKey="sessionPage"/></Panel>
  </section>:<section role="tabpanel" aria-label="Журнал"><OperationsToolbar label="Поиск в журнале безопасности" placeholder="Имя, номер пользователя или ID события" filters={[{key:'group',label:'Действия',options:{all:'Все действия, кроме просмотров',access:'Выдача и отзыв доступа',auth:'Вход и PIN',sessions:'Сеансы панели',backups:'Резервные копии',alerts:'Оповещения',work:'Ответственные за разборы',reads:'Просмотры данных'}},{key:'outcome',label:'Результат',options:{all:'Все результаты',SUCCEEDED:'Успешно',DENIED:'Отклонено',FAILED:'Ошибка'}}]}/>
   <Panel title="Журнал безопасности"><AdminTable primary={[0,2,3]}><table><thead><tr><th>Действие</th><th>Кто выполнил</th><th>Результат</th><th>Время · МСК</th></tr></thead><tbody>{data.audit.items.map(event=><tr key={event.id}><td><strong>{auditLabels[event.action]??'Административное действие'}</strong>{event.target&&<small>{event.target}</small>}<CopyReference value={event.id} label="ID события"/>{event.resourceId&&<CopyReference value={event.resourceId} label="ID объекта"/>}</td><td>{event.actor}{event.actorId&&<CopyReference value={String(event.actorPublicId??event.actorId)} label="ID пользователя"/>}</td><td><AdminBadge tone={event.outcome==='SUCCEEDED'?'green':'amber'}>{event.outcome==='SUCCEEDED'?'Успешно':event.outcome==='DENIED'?'Отклонено':'Ошибка'}</AdminBadge></td><td>{date(event.at,true)}</td></tr>)}</tbody></table>{!data.audit.items.length&&<Empty>Событий по выбранным условиям нет.</Empty>}</AdminTable><Pagination {...data.audit}/></Panel>
  </section>}
 </Frame>
}
