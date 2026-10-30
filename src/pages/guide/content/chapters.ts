import type { GuideArticle } from './types.ts'

export type GuideChapter = { id: string; title: string; summary: string; slugs: string[] }
const chapters: Record<string, GuideChapter[]> = {
  'getting-started': [
    { id: 'orientation', title: 'Освоиться в Staffly', summary: 'Первый вход, приглашение и рабочее пространство.', slugs: ['welcome', 'join-team', 'first-day', 'dashboard'] },
    { id: 'my-account', title: 'Настроить свой аккаунт', summary: 'Фото, контакты, безопасный вход и уведомления.', slugs: ['profile', 'security', 'notifications'] },
  ],
  shifts: [
    { id: 'calendar', title: 'Найти и спланировать смены', summary: 'От календаря до графика всей команды.', slugs: ['calendar', 'create-shifts', 'staff-demand', 'draft-schedule', 'draft-response'] },
    { id: 'exchange', title: 'Передать или обменять смену', summary: 'Предложение коллеге и подтверждение результата.', slugs: ['transfer-shift', 'swap-shifts', 'offer-review', 'shift-history'] },
    { id: 'time', title: 'Проверить отработанное время', summary: 'Часы, неявки, корректировки и статистика.', slugs: ['work-time', 'actual-time', 'shift-attendance', 'statistics'] },
    { id: 'reports', title: 'Подготовить отчёт', summary: 'Выгрузка Excel и собственные шаблоны.', slugs: ['excel-report', 'report-builder'] },
  ],
  requests: [
    { id: 'submit', title: 'Подать и отследить обращение', summary: 'Создание, редактирование и понятные статусы.', slugs: ['requests-overview', 'submit-request'] },
    { id: 'absence', title: 'Согласовать отсутствие', summary: 'Болезнь, отгул, отпуск и изменение планов.', slugs: ['absences', 'vacation-planning', 'vacation-changes'] },
    { id: 'review', title: 'Организовать согласование', summary: 'Решения руководителя, подмены и свои маршруты.', slugs: ['review-requests', 'staffing', 'request-builder'] },
  ],
  knowledge: [
    { id: 'library', title: 'Работать с библиотекой', summary: 'Поиск, загрузка и организация материалов.', slugs: ['document-library', 'publish-document', 'document-folders'] },
    { id: 'access', title: 'Выдать доступ и собрать подтверждения', summary: 'Кому доступен документ и кто с ним ознакомился.', slugs: ['document-access', 'acknowledgements', 'assign-documents', 'personal-documents'] },
    { id: 'events', title: 'Собрать команду на событие', summary: 'Встречи, адресаты и обновление планов.', slugs: ['events-overview', 'create-event', 'event-recipients'] },
  ],
  management: [
    { id: 'people', title: 'Собрать команду', summary: 'Приглашения, сотрудники и должности.', slugs: ['team-directory', 'invite-employees', 'positions', 'assign-location'] },
    { id: 'permissions', title: 'Разграничить доступ', summary: 'Роли и разрешения по организации и точкам.', slugs: ['roles', 'custom-roles', 'member-access', 'role-permissions'] },
    { id: 'locations', title: 'Настроить организацию', summary: 'Профиль, точки и правила работы команды.', slugs: ['create-organization', 'locations', 'planning-settings', 'offer-settings', 'request-types'] },
    { id: 'ownership', title: 'Управлять владением', summary: 'Передача организации и критические действия.', slugs: ['ownership'] },
  ],
}
export function guideChapters(collectionId: string, articles?: GuideArticle[]): GuideChapter[] {
  const list = chapters[collectionId] ?? []
  if (!articles) return list
  const allowed = new Set(articles.map(article => article.slug))
  return list.map(chapter => ({ ...chapter, slugs: chapter.slugs.filter(slug => allowed.has(slug)) })).filter(chapter => chapter.slugs.length)
}
