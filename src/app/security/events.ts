export const securityActions = {
  LOGIN: 'Вход в аккаунт', LOGIN_FAILED: 'Неудачный вход', SESSION_REVOKED: 'Сеанс завершён', SESSIONS_REVOKED: 'Сеансы завершены', REFRESH_REUSE: 'Обнаружен повтор refresh-токена',
  PASSWORD_CHANGED: 'Пароль изменён', PASSWORD_CREATED: 'Пароль создан', EMAIL_CHANGED: 'Почта изменена', YANDEX_LINKED: 'Яндекс ID подключён', YANDEX_UNLINKED: 'Яндекс ID отключён',
  CONFIRMATION_REQUESTED: 'Запрошено критическое подтверждение', CONFIRMATION_FAILED: 'Критическое подтверждение отклонено', OWNERSHIP_TRANSFERRED: 'Владение передано', ORGANIZATION_DELETED: 'Организация удалена',
  LOCATION_ARCHIVED: 'Точка закрыта',
  ACCOUNT_DELETION_REQUESTED: 'Запрошено удаление аккаунта', ACCOUNT_DELETED: 'Аккаунт удалён', DATA_PURGED: 'Завершена очистка данных', MEMBER_DEPARTED: 'Участник покинул область доступа', ACCESS_CHANGED: 'Права изменены',
  DOCUMENT_PREVIEW: 'Обращение к просмотру документа', DOCUMENT_DOWNLOAD: 'Обращение к скачиванию документа', ATTACHMENT_DOWNLOAD: 'Обращение к вложению заявки', MEMBER_PROFILE: 'Обращение к профилю сотрудника', REPORT_PREVIEW: 'Обращение к отчёту', REPORT_EXPORT: 'Запрошен экспорт', EXPORT_DOWNLOAD: 'Обращение к файлу экспорта', JOURNAL_VIEWED: 'Журнал безопасности просмотрен',
} as const
export type SecurityAction = keyof typeof securityActions
export type SecurityEntry = { actorLabel: string; id: string; action: SecurityAction; outcome: 'SUCCEEDED' | 'DENIED' | 'FAILED'; createdAt: string; correlationId: string; resourceType: string | null; resourceId: string | null; count: number | null }
export type SecurityHistory = { entries: SecurityEntry[]; retentionDays: number; cleanupEnabled: boolean; pagination: { page: number; pages: number; total: number } }
