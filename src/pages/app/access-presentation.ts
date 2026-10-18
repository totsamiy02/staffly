import { permissionCatalog, type Permission } from '../../app/access/catalog.ts'

export const accessModules: Record<string, { icon: string; description: string }> = {
  'Сотрудники': { icon: 'people', description: 'Состав команды, контактные данные и кадровые действия.' },
  'Расписание': { icon: 'calendar', description: 'Просмотр и планирование смен, учёт рабочего времени.' },
  'Отсутствия': { icon: 'absence', description: 'Отсутствия сотрудников и доступ к их основаниям.' },
  'Заявки': { icon: 'requests', description: 'Личные обращения, входящие заявки и подмены.' },
  'Передача и обмен': { icon: 'exchange', description: 'Передача смен, обмен и согласование предложений.' },
  'Статистика и отчёты': { icon: 'chart', description: 'Показатели работы, отчёты и выгрузка в Excel.' },
  'Документы': { icon: 'document', description: 'Библиотека, личные документы и ознакомления.' },
  'События': { icon: 'calendar', description: 'События для команды и управление публикациями.' },
  'Организация и точки': { icon: 'building', description: 'Сводка, точки и общие настройки организации.' },
}

export const permissionHints: Partial<Record<Permission, string>> = {
  'requestTypes.manage':'Создание, изменение, отключение и удаление пользовательских типов; общие правила отпусков',
  'vacations.view':'Календарь и периоды отпусков в разрешённых точках',
  'vacations.collect':'Сбор дат, выбор аудитории и контроль ответов',
  'vacations.resolve':'Согласование периодов и возврат на доработку',
  'vacations.change':'Перенос, продление, отзыв и отмена с историей',
  'requests.onBehalf':'Оформление отпуска или пользовательского обращения за сотрудника',
  'requests.selfResolve':'Явное исключение: согласование собственных обращений',
  'members.contacts': 'Email и телефон сотрудников',
  'members.exclude': 'Прекращение участия в организации',
  'schedule.own': 'Только смены самого сотрудника',
  'schedule.actual': 'Редактирование фактически отработанного времени',
  'absences.details': 'В том числе причины и подтверждающие материалы',
  'requests.attachments': 'Файлы, приложенные другими сотрудниками',
  'reports.export': 'Скачивание отчёта в формате XLSX',
  'reports.templates.all': 'Изменение шаблонов других сотрудников',
  'documents.view': 'С учётом аудитории документа и родительских папок',
  'documents.access': 'Выбор ролей и сотрудников с доступом',
  'documents.personal.view': 'Чужие личные документы в доступной области',
  'documents.personal.edit': 'Загрузка и изменение чужих личных документов',
  'documents.shared': 'Для действий также нужны соответствующие права',
  'locations.browse': 'Расширяет разрешённый просмотр публичных разделов',
}


export const accessGroups = [...new Set(permissionCatalog.map(permission => permission.group))]
