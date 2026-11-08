/* oxlint-disable react/only-export-components -- Shared feature hooks and components. */
import { useState,type ReactNode } from 'react'
import type { AdminReadState } from '../admin-data.tsx'
import { PageHead } from '../admin-elements.tsx'
import { ReadError } from '../admin-feedback.tsx'
import { ManagementActionDialog,type ProtectedAction } from './action-dialog.tsx'
import type { ManagementResult } from './contracts.ts'
import BackupJobFeedback from './backup-job-feedback.tsx'
export function useAction(refresh:()=>void){
 const [action,setAction]=useState<ProtectedAction|null>(null),[result,setResult]=useState<{action:ProtectedAction['spec']['action'];value:ManagementResult}|null>(null)
 const messages={ACCESS_GRANT:'Административный доступ выдан.',ACCESS_REVOKE:'Административный доступ отозван.',SESSION_REVOKE:'Выбранный административный сеанс завершён.',ALERT_RULE:'Правило оповещения изменено.',BACKUP_CREATE:'Создание копии запрошено.'}
 return{open:setAction,feedback:<>{result&&(result.action==='BACKUP_CREATE'&&result.value.resourceId?<BackupJobFeedback id={result.value.resourceId}/>:<p className="admin-notice" role="status">{messages[result.action]}</p>)}{action&&<ManagementActionDialog action={action} onClose={()=>{setAction(null);action.onReturn?.()}} onDone={value=>{setResult({action:action.spec.action,value});setAction(null);action.onCompleted?.();refresh()}}/>}</>}
}
export function Frame({title,children,error,refresh,readState}:{title:string;children:ReactNode;error:Error|null;refresh:()=>void;readState:AdminReadState}){return <><PageHead title={title}/><ReadError error={error} retry={refresh} state={readState}/>{children}</>}
