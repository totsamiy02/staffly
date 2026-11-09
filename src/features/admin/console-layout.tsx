/* oxlint-disable react/only-export-components -- Shared layout and presentation metadata. */
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AdminIcon } from './admin-elements.tsx'
import './console.scss'

export default function ConsoleLayout({children,section='Операционная панель',className=''}:{children:ReactNode;section?:string;className?:string}){
 const location=useLocation()
 return <div className={`admin-console ${className}`} data-console-path={location.pathname}><div className="admin-console-eyebrow">{section}</div>{children}</div>
}
export const consoleDescriptions:Record<string,string>={
 'Безопасность':'Контроль доступа, сеансов и административных действий',
 'Администраторы':'Доступ к управлению сервисом и защита учётных записей',
 'Резервные копии':'Создание, проверка и восстановление резервных копий',
 'Оповещения':'Состояние сервиса, срабатывания и настройки правил',
}
export function ConsoleGuidance({kind}:{kind:'access'|'backups'}){
 const items=kind==='access'?[
  ['key','Личный аккаунт','Администратор входит под своей учётной записью.'],
  ['mail','Подтверждение почтой','После пароля потребуется одноразовый код.'],
  ['lock','Собственный PIN','Панель блокируется после пяти минут бездействия.'],
 ]:[
  ['check','Целостность','Проверка формата и контрольной суммы копии.'],
  ['database','Пробное восстановление','Проверка развёртывания в отдельной временной базе.'],
  ['disk','Полный комплект','Документы и изображения резервируются отдельно от базы.'],
 ]
 return <div className="admin-console-guidance">{items.map(([icon,title,description])=><div key={title}><AdminIcon name={icon}/><section><strong>{title}</strong><p>{description}</p></section></div>)}</div>
}
