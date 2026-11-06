import { securityActions } from '../../app/security/events.ts'
export const eventModules:Record<string,string>={security:'Безопасность',reports:'Отчёты',planning:'Планирование',organization:'Организация',members:'Участники',locations:'Точки',invitations:'Приглашения',schedule:'Расписание',requests:'Заявки',documents:'Документы',events:'События',access:'Права доступа',subscription:'Подписка'}
const verbs:Record<string,string>={CREATE:'Создание записи',UPDATE:'Изменение записи',DELETE:'Удаление записи'}
export const eventActionLabels:Record<string,string>={...securityActions,...Object.fromEntries(Object.entries(eventModules).flatMap(([module,label])=>Object.entries(verbs).map(([verb,text])=>[`${module}_${verb}`,`${label}: ${text.toLowerCase()}`])))}
export const outcomeLabels:Record<string,string>={SUCCEEDED:'Успешно',DENIED:'Отказано',FAILED:'Ошибка'}
