import type { GuideCategoryId } from './types.ts'
export const guideCategories: { id: GuideCategoryId; title: string; description: string; icon: string }[] = [
  { id: 'start', title: 'Первые шаги', description: 'Начало работы, организации и навигация', icon: 'compass' },
  { id: 'schedule', title: 'Расписание и смены', description: 'Календарь, планирование, передача и обмен', icon: 'calendar' },
  { id: 'time', title: 'Рабочее время и отчёты', description: 'Часы, статистика и выгрузка Excel', icon: 'clock' },
  { id: 'requests', title: 'Заявки и отсутствия', description: 'Обращения, отгулы, подмены и согласование', icon: 'message' },
  { id: 'documents', title: 'Документы', description: 'Библиотека, папки, редакции и ознакомление', icon: 'file' },
  { id: 'events', title: 'События', description: 'Встречи, получатели и календарь команды', icon: 'event' },
  { id: 'team', title: 'Команда и приглашения', description: 'Сотрудники, должности и права доступа', icon: 'users' },
  { id: 'organization', title: 'Организация и настройки', description: 'Точки, собственные роли, разрешения и владение', icon: 'settings' },
  { id: 'account', title: 'Профиль и уведомления', description: 'Личные данные, безопасность и сообщения', icon: 'bell' },
]
export const audienceLabels = { everyone: 'Всем пользователям', manager: 'Руководителю', owner: 'Владельцу' } as const

// The public navigation stays small; source topics and existing article URLs stay stable.
export const guideCollections: { id: string; title: string; description: string; icon: string; categories: GuideCategoryId[]; shortcuts: string[] }[] = [
  { id: 'getting-started', title: 'Начало работы', description: 'Войти в команду, освоиться и настроить свой профиль.', icon: 'compass', categories: ['start', 'account'], shortcuts: ['first-day', 'join-team', 'profile'] },
  { id: 'shifts', title: 'Смены и рабочее время', description: 'Расписание, передача смен, учёт часов и отчёты.', icon: 'calendar', categories: ['schedule', 'time'], shortcuts: ['calendar', 'transfer-shift', 'work-time'] },
  { id: 'requests', title: 'Заявки и отсутствия', description: 'Отгулы, отпуск, болезнь и согласование обращений.', icon: 'message', categories: ['requests'], shortcuts: ['submit-request', 'review-requests', 'absences'] },
  { id: 'knowledge', title: 'Документы и события', description: 'Рабочие материалы, ознакомления и встречи команды.', icon: 'file', categories: ['documents', 'events'], shortcuts: ['document-library', 'acknowledgements', 'events-overview'] },
  { id: 'management', title: 'Команда и настройки', description: 'Сотрудники, точки, свои роли и разграничение доступа.', icon: 'users', categories: ['team', 'organization'], shortcuts: ['invite-employees', 'custom-roles', 'member-access'] },
]
export const guideCollectionFor = (category: GuideCategoryId) => guideCollections.find(item => item.categories.includes(category))!
