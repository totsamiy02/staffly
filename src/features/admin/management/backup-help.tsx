import { useRef } from 'react'
import AnimatedOverlay from '../../../component/ui/modal/animated-overlay.tsx'
import { useDialogFocus } from '../../../component/ui/modal/dialog-focus.ts'
import { AdminHelp,AdminIcon,date } from '../admin-elements.tsx'
import { CopyDiagnostics } from '../operations/elements.tsx'
import type { BackupsState } from './contracts.ts'
type Backup=BackupsState['items'][number]
export function BackupExplainer({onRecovery}:{onRecovery:()=>void}){return <div className="admin-backup-help-actions"><AdminHelp label="Что входит в резервную копию?">Снимок содержит базу данных; документы и аватары резервируются отдельно. Проверка целостности сверяет формат и контрольную сумму. Пригодность подтверждают пробным восстановлением в отдельную базу.</AdminHelp><button type="button" className="admin-btn" onClick={onRecovery}>Как восстановить данные</button></div>}
const recoverySteps=[
 ['Сохранить актуальное состояние','Сделать новую копию базы и файлов. Сохранить актуальный независимый реестр удалений и отзывов отдельно от восстанавливаемого dump.'],
 ['Восстановить выбранную копию отдельно','Использовать пустую тестовую базу с закрытым внешним доступом. Проверить версию схемы, организации, рабочие записи и соответствующие файлы.'],
 ['Сверить удаления и отозванный доступ','Сопоставить восстановленную базу с последним независимым реестром. Повторно применить удаления и отзывы. Реестр из старого dump не заменяет актуальный.'],
 ['Проверить ограничения и владение','Проверить приостановки очистки (hold), владельцев организаций, действующие разрешения и согласованность файлов с базой.'],
 ['Проверить сеансы и очереди','Отозвать восстановленные устаревшие сеансы и подтверждения. Проверить актуальность очередей писем и выгрузок; устаревшие задания не возобновлять.'],
 ['Подготовить переключение','Согласовать окно обслуживания и ответственного оператора. Остановить запись и обработчики, перенести нужные изменения после снимка и переключить приложение на проверенную базу.'],
 ['Зафиксировать проверку и открыть доступ','Проверить вход, организации, документы, права и очереди. Зафиксировать результат сверки и только после этого открыть доступ и возобновить запись и обработчики.'],
] as const
function RecoverySurface({backup,close}:{backup:Backup|null;close:()=>void}){
 const ref=useRef<HTMLDivElement>(null);useDialogFocus(ref)
 const plan=['Staffly · план восстановления базы',...(backup?[`ID копии: ${backup.id}`,`Дата снимка: ${backup.createdAt}`,`SHA-256: ${backup.sha256}`,`Проверка на отдельной пустой БД: npm run db:restore:check -- --backup-id=${backup.id} --sha256=${backup.sha256}`]:[]),...recoverySteps.map(([title,text],index)=>`${index+1}. ${title}. ${text}`),'Не запускать восстановление в действующую базу. Изменения после даты снимка потребуют отдельного переноса.'].join('\n')
 return <section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="backup-recovery-title" className="admin-ops-dialog admin-backup-recovery"><header><div className="admin-auth-symbol"><AdminIcon name="database"/></div><button className="admin-icon-button" type="button" aria-label="Закрыть план восстановления" onClick={close}><AdminIcon name="close"/></button></header><h2 id="backup-recovery-title">{backup?'План восстановления копии':'Как вернуть данные из копии'}</h2>{backup&&<p>Состояние базы на {date(backup.createdAt,true)} · МСК.</p>}<p>Восстановление выполняет оператор с доступом к серверу. Здесь можно подготовить план и передать ему сведения о копии.</p><ol>{recoverySteps.map(([title,text])=><li key={title}><strong>{title}</strong>{text}</li>)}</ol><p className="admin-notice">База вернётся к дате снимка. Более поздние изменения автоматически не переносятся. Архив базы не восстанавливает удалённые файлы документов.</p><CopyDiagnostics text={plan}/><div className="admin-actions"><button type="button" className="admin-btn admin-btn--primary" onClick={close}>Понятно</button></div></section>
}
export function BackupRecoveryDialog({backup,onClose}:{backup:Backup|null;onClose:()=>void}){return <AnimatedOverlay variant="modal" className="admin-root admin-ops-overlay admin-console-overlay" onClose={onClose}>{close=><RecoverySurface backup={backup} close={close}/>}</AnimatedOverlay>}
