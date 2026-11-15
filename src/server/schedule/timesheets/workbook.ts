import ExcelJS from 'exceljs';
import type { TimesheetSnapshot } from '../../../app/schedule/timesheets/types.ts';
import { attendanceNames, absenceNames } from '../../../app/schedule/timesheets/types.ts';
import { dateTimeParts } from '../../../shared/date-time.ts';

function excelDateTime(value: string, timezone: string) {
  const p = dateTimeParts(new Date(value), timezone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}
type Cell = string | number | boolean | Date | null;
export async function timesheetWorkbook(snapshot: TimesheetSnapshot, metadata: {
  version: number;
  currentVersion: number;
  closedAt: Date;
  status: string;
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Staffly';
  workbook.created = metadata.closedAt;
  function sheet(name: string, columns: Array<[
    string,
    number,
    string?
  ]>, rows: Cell[][]) {
    const page = workbook.addWorksheet(name);
    page.columns = columns.map(([header, width, numFmt = '@']) => ({
      header,
      width,
      style: { numFmt, alignment: { vertical: 'middle', wrapText: true }, font: { name: 'Arial', size: 11 } }
    }));
    page.getRow(1).font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    page.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF30343B' } };
    page.getRow(1).height = 44;
    page.addRows(rows);
    page.eachRow((row, index) => {
      if (index > 1)
        row.height = 36;
    });
    page.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, page.rowCount), column: columns.length } };
    page.views = [{ state: 'frozen', ySplit: 1, xSplit: name === 'Параметры' ? 0 : 2 }];
    page.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:1'
    };
    return page;
  }
  const hours = (value: number) => value / 60;
  const numeric: [
    number,
    string
  ] = [15, '0.00'];
  sheet('Сводка', [
    ['Табельный номер', 18],
    ['ФИО', 32],
    ['Должности', 25],
    ['Состояние', 16],
    ['План, ч', ...numeric],
    ['Факт, ч', ...numeric],
    ['Отклонение, ч', ...numeric],
    ['Отработано смен', 17, '0'],
    ['Неявок', 12, '0'],
    ['Отпуск, дней', 16, '0'],
    ['Болезнь, дней', 16, '0'],
    ['Другие отсутствия, дней', 22, '0'],
    ['ID сотрудника', 38]
  ], snapshot.members.map(member => [
    member.number,
    member.name,
    member.positions,
    member.former ? 'Бывший' : 'Активный',
    hours(member.plannedMinutes),
    hours(member.actualMinutes),
    hours(member.actualMinutes - member.plannedMinutes),
    member.workedShifts,
    member.noShows,
    member.vacationDays,
    member.sickDays,
    member.otherAbsenceDays,
    member.id
  ]));
  sheet('Смены', [
    ['Табельный номер', 18],
    ['ФИО', 32],
    ['Должность', 25],
    ['Дата учёта', 16, 'dd.mm.yyyy'],
    ['План: начало', 24, 'dd.mm.yyyy hh:mm'],
    ['План: конец', 24, 'dd.mm.yyyy hh:mm'],
    ['Факт: начало', 24, 'dd.mm.yyyy hh:mm'],
    ['Факт: конец', 24, 'dd.mm.yyyy hh:mm'],
    ['План, ч', ...numeric],
    ['Факт, ч', ...numeric],
    ['Перерыв по плану, мин', 22, '0'],
    ['Перерыв по факту, мин', 22, '0'],
    ['Явка', 24],
    ['Причина', 45],
    ['ID смены', 38],
    ['ID сотрудника', 38]
  ], snapshot.shifts.map(shift => [
    shift.number,
    shift.name,
    shift.position,
    new Date(shift.date),
    excelDateTime(shift.scheduledStart, snapshot.timezone),
    excelDateTime(shift.scheduledEnd, snapshot.timezone),
    shift.actualStart ? excelDateTime(shift.actualStart, snapshot.timezone) : null,
    shift.actualEnd ? excelDateTime(shift.actualEnd, snapshot.timezone) : null,
    hours(shift.plannedMinutes),
    hours(shift.actualMinutes),
    shift.breakMinutes,
    shift.actualBreakMinutes,
    attendanceNames[shift.attendance] ?? shift.attendance,
    shift.reason,
    shift.id,
    shift.memberId
  ]));
  sheet('Отсутствия', [
    ['Табельный номер', 18],
    ['ФИО', 32],
    ['Вид', 22],
    ['Начало', 16, 'dd.mm.yyyy'],
    ['Окончание', 16, 'dd.mm.yyyy'],
    ['В периоде: с', 16, 'dd.mm.yyyy'],
    ['В периоде: по', 16, 'dd.mm.yyyy'],
    ['Календарных дней в точке', 24, '0'],
    ['Дней отпуска без праздников', 26, '0'],
    ['Комментарий', 45],
    ['ID заявки', 38],
    ['Основание отсутствия', 26],
    ['ID сотрудника', 38]
  ], snapshot.absences.map(item => [
    item.number,
    item.name,
    absenceNames[item.type] ?? 'Отсутствие',
    new Date(item.start),
    new Date(item.end),
    new Date(item.overlapStart),
    new Date(item.overlapEnd),
    item.days,
    item.vacationDays,
    item.comment,
    item.requestId,
    item.reason ? ({ SICK: 'Болезнь', PERSONAL: 'Личные обстоятельства', OTHER: 'Другое' } as Record<string, string>)[item.reason] ?? item.reason : null,
    item.memberId
  ]));
  const daily: Cell[][] = [];
  for (const member of snapshot.members) {
    const days = new Date(Number(snapshot.month.slice(0, 4)), Number(snapshot.month.slice(5)), 0).getDate();
    for (let day = 1; day <= days; day++) {
      const date = `${snapshot.month}-${String(day).padStart(2, '0')}`;
      const shifts = snapshot.shifts.filter(item => item.memberId === member.id && item.date === date);
      const absences = snapshot.absences.filter(item => item.memberId === member.id && item.dates.includes(date));
      daily.push([
        member.number,
        member.name,
        new Date(date),
        [...shifts.map(item => attendanceNames[item.attendance]),
        ...absences.map(item => absenceNames[item.type] ?? 'Отсутствие')].join('; ') || 'Нет данных',
        hours(shifts.reduce((sum, item) => sum + item.plannedMinutes, 0)),
        hours(shifts.reduce((sum, item) => sum + item.actualMinutes, 0))
      ]);
    }
  }
  sheet('По дням', [['Табельный номер', 18],
  ['ФИО', 32],
  ['Дата', 16, 'dd.mm.yyyy'],
  ['Отметки', 45],
  ['План, ч', ...numeric],
  ['Факт, ч', ...numeric]], daily);
  sheet('Параметры', [['Параметр', 36], ['Значение', 110]], [
    ['Организация', snapshot.organization],
    ['Точка', snapshot.location],
    ['Период', snapshot.month],
    ['Часовой пояс', snapshot.timezone],
    ['Версия', metadata.version],
    ['Текущая версия на момент скачивания', metadata.currentVersion],
    ['Состояние периода', metadata.status],
    ['Закрыт', metadata.closedAt.toISOString()],
    ['Зафиксировал', snapshot.closure?.name ?? snapshot.approval?.reviewerName ?? null],
    ['ID автора фиксации', snapshot.closure?.memberId ?? snapshot.approval?.reviewerMemberId ?? null],
    ['Источник', 'Неизменяемая закрытая версия табеля'],
    ['Версия правил расчёта', snapshot.calculationRules?.version ?? 'Исходные правила сохранённой версии'],
    ['Часы',
      'Только подтверждённый факт. Неявка — 0. Перерывы включены в длительность согласно модели Staffly; величины перерывов приведены отдельно.'],
    ['Ночные смены', 'Целиком по местной дате планового начала; часы не распределяются между сутками.'],
    [
      'Отсутствия',
      'Дни в области этой точки; отпуска без праздников. Не суммируйте дни одного сотрудника между точками. Отсутствия не вычитаются из часов автоматически.'
    ],
    [
      'Расчёт зарплаты',
      'Ставки, суммы, доплаты и юридическая классификация ночных/сверхурочных часов не рассчитываются. Нет данных за день не означает выходной.'
    ],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
