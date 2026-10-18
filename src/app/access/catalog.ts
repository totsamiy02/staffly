// Shared permission catalogue: API and UI use the same stable keys.
export const permissionCatalog = [
  {
    "key": "members.view",
    "label": "Список сотрудников",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.contacts",
    "label": "Контактные данные",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.invite",
    "label": "Приглашение",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.invites.revoke",
    "label": "Отзыв приглашений",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.positions",
    "label": "Назначение должностей",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.assign",
    "label": "Добавление в точку",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.remove",
    "label": "Удаление из точки",
    "group": "Сотрудники",
    "scope": "location"
  },
  {
    "key": "members.exclude",
    "label": "Исключение из организации",
    "group": "Сотрудники",
    "scope": "organization"
  },
  {
    "key": "schedule.own",
    "label": "Свои смены",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.view",
    "label": "Смены коллег",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.history",
    "label": "История смен",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.create",
    "label": "Создание смен",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.edit",
    "label": "Изменение смен",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.cancel",
    "label": "Отмена смен",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.actual",
    "label": "Корректировка фактического времени",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.templates",
    "label": "Шаблоны смен",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "schedule.settings",
    "label": "Настройки расписания",
    "group": "Расписание",
    "scope": "location"
  },
  {
    "key": "absences.own",
    "label": "Свои отсутствия",
    "group": "Отсутствия",
    "scope": "location"
  },
  {
    "key": "absences.view",
    "label": "Отсутствия коллег",
    "group": "Отсутствия",
    "scope": "location"
  },
  {
    "key": "absences.details",
    "label": "Причины и основания",
    "group": "Отсутствия",
    "scope": "location"
  },
  {
    "key": "absences.edit",
    "label": "Изменение отсутствий",
    "group": "Отсутствия",
    "scope": "location"
  },
  {
    "key": "absences.cancel",
    "label": "Отмена отсутствий",
    "group": "Отсутствия",
    "scope": "location"
  },
  {
    "key": "requests.own",
    "label": "Свои заявки",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "requests.create",
    "label": "Создание своих заявок",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "requests.edit",
    "label": "Изменение и отмена своих заявок",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "requests.view",
    "label": "Входящие заявки",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "requests.resolve",
    "label": "Рассмотрение заявок",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "requests.attachments",
    "label": "Вложения чужих заявок",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "staffing.create",
    "label": "Публикация потребности в подмене",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "staffing.respond",
    "label": "Отклик на подмену",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "staffing.resolve",
    "label": "Согласование подмен",
    "group": "Заявки",
    "scope": "location"
  },
  {
    "key": "offers.transfer",
    "label": "Предложение передачи",
    "group": "Передача и обмен",
    "scope": "location"
  },
  {
    "key": "offers.swap",
    "label": "Предложение обмена",
    "group": "Передача и обмен",
    "scope": "location"
  },
  {
    "key": "offers.accept",
    "label": "Принятие предложений",
    "group": "Передача и обмен",
    "scope": "location"
  },
  {
    "key": "offers.approve",
    "label": "Согласование предложений",
    "group": "Передача и обмен",
    "scope": "location"
  },
  {
    "key": "offers.settings",
    "label": "Настройка режимов",
    "group": "Передача и обмен",
    "scope": "organization"
  },
  {
    "key": "statistics.own",
    "label": "Свои показатели",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "statistics.view",
    "label": "Показатели команды",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "reports.preview",
    "label": "Предпросмотр отчётов",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "reports.export",
    "label": "Выгрузка Excel",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "reports.templates",
    "label": "Свои шаблоны отчётов",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "reports.templates.all",
    "label": "Чужие шаблоны отчётов",
    "group": "Статистика и отчёты",
    "scope": "location"
  },
  {
    "key": "documents.view",
    "label": "Просмотр библиотеки",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.download",
    "label": "Скачивание",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.upload",
    "label": "Загрузка",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.folders",
    "label": "Создание папок",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.edit",
    "label": "Изменение",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.delete",
    "label": "Удаление и восстановление",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.access",
    "label": "Изменение доступа",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.assign",
    "label": "Назначение ознакомлений",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.control",
    "label": "Контроль ознакомлений",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.personal.view",
    "label": "Личные документы сотрудников",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.personal.edit",
    "label": "Управление личными документами",
    "group": "Документы",
    "scope": "location"
  },
  {
    "key": "documents.shared",
    "label": "Общие документы организации",
    "group": "Документы",
    "scope": "organization"
  },
  {
    "key": "events.view",
    "label": "Адресованные события",
    "group": "События",
    "scope": "location"
  },
  {
    "key": "events.create",
    "label": "Создание событий",
    "group": "События",
    "scope": "location"
  },
  {
    "key": "events.edit",
    "label": "Изменение событий",
    "group": "События",
    "scope": "location"
  },
  {
    "key": "events.cancel",
    "label": "Отмена событий",
    "group": "События",
    "scope": "location"
  },
  {
    "key": "events.shared",
    "label": "Общие события организации",
    "group": "События",
    "scope": "organization"
  },
  {
    "key": "dashboard.view",
    "label": "Сводка команды",
    "group": "Организация и точки",
    "scope": "location"
  },
  {
    "key": "locations.browse",
    "label": "Просмотр других действующих точек",
    "group": "Организация и точки",
    "scope": "organization"
  },
  {
    "key": "locations.edit",
    "label": "Изменение данных точки",
    "group": "Организация и точки",
    "scope": "location"
  },
  {
    "key": "locations.create",
    "label": "Создание точек",
    "group": "Организация и точки",
    "scope": "organization"
  },
  {
    "key": "organization.edit",
    "label": "Реквизиты организации",
    "group": "Организация и точки",
    "scope": "organization"
  },
  {
    "key": "positions.manage",
    "label": "Справочник должностей",
    "group": "Организация и точки",
    "scope": "organization"
  },
  {
    "key": "requestTypes.manage",
    "label": "Типы заявок",
    "group": "Организация и точки",
    "scope": "organization"
  },
  { key: 'coverage.view', label: 'Потребность и покрытие', group: 'Расписание', scope: 'location' },
  { key: 'coverage.manage', label: 'Управление потребностью', group: 'Расписание', scope: 'location' },
  { key: 'drafts.view', label: 'Предварительные графики команды', group: 'Расписание', scope: 'location' },
  { key: 'drafts.edit', label: 'Создание и правка предварительного графика', group: 'Расписание', scope: 'location' },
  { key: 'drafts.discuss', label: 'Управление обсуждением графика', group: 'Расписание', scope: 'location' },
  { key: 'drafts.resolve', label: 'Обработка замечаний к графику', group: 'Расписание', scope: 'location' },
  { key: 'drafts.apply', label: 'Применение графика', group: 'Расписание', scope: 'location' },
  { key: "vacations.view", label: "Просмотр отпусков команды", group: "Заявки", scope: "location" },
  { key: "vacations.collect", label: "Создание и управление сбором дат", group: "Заявки", scope: "location" },
  { key: "requests.onBehalf", label: "Оформление обращений за сотрудника", group: "Заявки", scope: "location" },
  { key: "vacations.resolve", label: "Согласование отпусков и возврат на доработку", group: "Заявки", scope: "location" },
  { key: "vacations.change", label: "Перенос, продление и отмена отпусков", group: "Заявки", scope: "location" },
  { key: "requests.selfResolve", label: "Согласование собственных обращений", group: "Заявки", scope: "location" },
] as const
export type Permission = typeof permissionCatalog[number]['key']
export const permissionKeys = permissionCatalog.map(item => item.key)
export const recommendedPermissions: Record<'OWNER' | 'ADMIN' | 'MEMBER', Permission[]> = {
  OWNER: [...permissionKeys],
  ADMIN: ["vacations.view", "vacations.collect", "vacations.resolve", "vacations.change", "requests.onBehalf", "coverage.view", "coverage.manage", "drafts.view", "drafts.edit", "drafts.discuss", "drafts.resolve", "drafts.apply", "members.view", "members.contacts", "members.invite", "members.invites.revoke", "members.positions", "members.assign", "members.remove", "schedule.own", "schedule.view", "schedule.history", "schedule.create", "schedule.edit", "schedule.cancel", "schedule.actual", "schedule.templates", "schedule.settings", "absences.own", "absences.view", "absences.details", "absences.edit", "absences.cancel", "requests.own", "requests.create", "requests.edit", "requests.view", "requests.resolve", "requests.attachments", "staffing.create", "staffing.respond", "staffing.resolve", "offers.transfer", "offers.swap", "offers.accept", "offers.approve", "statistics.own", "statistics.view", "reports.preview", "reports.export", "reports.templates", "documents.view", "documents.download", "documents.upload", "documents.folders", "documents.edit", "documents.delete", "documents.access", "documents.assign", "documents.control", "documents.personal.view", "documents.personal.edit", "events.view", "events.create", "events.edit", "events.cancel", "dashboard.view", "locations.edit", "locations.browse"],
  MEMBER: ["members.view", "members.contacts", "schedule.own", "schedule.view", "absences.own", "requests.own", "requests.create", "requests.edit", "staffing.respond", "offers.transfer", "offers.swap", "offers.accept", "statistics.own", "documents.view", "documents.download", "events.view", "locations.browse", "dashboard.view"],
}
export const systemRoleNames = { OWNER: 'Владелец', ADMIN: 'Администратор', MEMBER: 'Пользователь' }
export type AccessSnapshot = { owner?: boolean; permissions?: string[]; organizationPermissions?: string[]; permissionLocations?: Record<string, string[]>; roleName?: string }
export function canAccess(access: AccessSnapshot, permission: Permission) { return Boolean(access.owner || access.permissions?.includes(permission)) }

// Selecting an action also enables the minimum read permissions it needs.
export const permissionDependencies: Partial<Record<Permission, Permission[]>> = {
  'vacations.collect':['vacations.view','members.view'], 'vacations.resolve':['vacations.view','requests.view'], 'vacations.change':['vacations.view','absences.view'], 'requests.onBehalf':['requests.create','members.view'], 'requests.selfResolve':['requests.own'],
  'coverage.manage':['coverage.view'], 'drafts.view':['schedule.view'], 'drafts.edit':['drafts.view','members.view'], 'drafts.discuss':['drafts.view'], 'drafts.resolve':['drafts.view'], 'drafts.apply':['drafts.view'],
  'members.contacts':['members.view'], 'members.invite':['members.view'], 'members.invites.revoke':['members.invite'], 'members.assign':['members.view'], 'members.remove':['members.view'], 'members.positions':['members.view'],
  'schedule.create':['schedule.view'], 'schedule.edit':['schedule.view'], 'schedule.cancel':['schedule.view'], 'schedule.actual':['schedule.view'], 'schedule.history':['schedule.view'],
  'absences.details':['absences.view'], 'absences.edit':['absences.view'], 'absences.cancel':['absences.view'],
  'requests.create':['requests.own'], 'requests.edit':['requests.own'], 'requests.resolve':['requests.view'], 'requests.attachments':['requests.view'], 'staffing.resolve':['requests.view'],
  'reports.export':['reports.preview'], 'reports.templates':['reports.preview'], 'reports.templates.all':['reports.templates'],
  'documents.download':['documents.view'], 'documents.upload':['documents.view'], 'documents.folders':['documents.view'], 'documents.edit':['documents.view'], 'documents.delete':['documents.view'], 'documents.access':['documents.view'], 'documents.assign':['documents.view','documents.control'], 'documents.control':['documents.view'], 'documents.personal.view':['documents.view'], 'documents.personal.edit':['documents.personal.view','documents.edit'],
  'events.create':['events.view'], 'events.edit':['events.view'], 'events.cancel':['events.view'],
}
export function normalizePermissions(keys: string[]): Permission[] {
  const result = new Set(keys.filter((key): key is Permission => permissionKeys.includes(key as Permission)))
  let changed = true
  while (changed) { changed = false; for (const key of result) for (const dependency of permissionDependencies[key] ?? []) if (!result.has(dependency)) { result.add(dependency); changed = true } }
  return permissionKeys.filter(key => result.has(key))
}
export function togglePermission(keys: string[], key: Permission, enabled: boolean): Permission[] {
  if (enabled) return normalizePermissions([...keys,key])
  let result = keys.filter(value=>value!==key) as Permission[], previous = -1
  while (previous !== result.length) { previous = result.length; result = result.filter(value=>(permissionDependencies[value]??[]).every(dependency=>result.includes(dependency))) }
  return result
}

// Local public browsing and employee self-service are the only cross-point grants.
export const crossPointPermissionKeys: Permission[] = ['staffing.respond','requests.own','requests.edit']
export const browsePermissionKeys: Permission[] = ['members.view','members.contacts','schedule.view','dashboard.view','events.view','locations.browse']
