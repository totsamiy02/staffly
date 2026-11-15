import { useState } from 'react';
import { formatDuration, confirmedDuration } from '../../../../app/schedule/date-utils.ts';
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx';
import DocumentDialog from '../../../../component/ui/modal/document-dialog.tsx';
import './work-time-accounting.scss';

type Metrics = {
  plannedMinutes: number;
  estimatedMinutes: number;
  workedMinutes: number;
  confirmedShifts: number;
};

export function WorkTimeTotals({ metrics }: { metrics?: Metrics | null }) {
  return <div className="work-time-totals">
    <article>
      <span>По плану</span>
      <strong>{formatDuration(metrics?.plannedMinutes ?? 0)}</strong>
    </article>
    <article>
      <span>Предварительно</span>
      <strong>{formatDuration(metrics?.estimatedMinutes ?? 0)}</strong>
      <small>Факт и оценка по расписанию</small>
    </article>
    <article>
      <span>Подтверждено</span>
      <strong>{confirmedDuration(metrics?.workedMinutes ?? 0, metrics?.confirmedShifts ?? 0)}</strong>
      <small>Результатов: {metrics?.confirmedShifts ?? 0}</small>
    </article>
  </div>;
}

export function WorkTimeRulesButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="app-secondary work-time-rules-button" onClick={() => setOpen(true)}>Правила расчёта</button>
    {open && <AnimatedOverlay variant="modal" onClose={() => setOpen(false)}>{close => <DocumentDialog title="Правила расчёта времени" eyebrow="Учёт времени" onClose={close} className="work-time-rules-dialog">
      <dl className="work-time-rule-list">
        <div><dt>План</dt><dd>Интервал из расписания. Отменённые смены исключены из итогов.</dd></div>
        <div><dt>Предварительно</dt><dd>Подтверждённые часы и оценка остальных смен по имеющимся отметкам и расписанию. Будущие смены входят в прогноз.</dd></div>
        <div><dt>Подтверждено</dt><dd>Завершённая работа с подтверждёнными приходом и уходом либо подтверждённая неявка. Нет факта — «—», неявка — 0 часов.</dd></div>
        <div><dt>Перерывы включены</dt><dd>Перерыв сохраняется отдельно и не вычитается из длительности.</dd></div>
        <div><dt>Полные минуты</dt><dd>Без округления до 5, 10 или 15 минут. Сначала суммируются минуты, затем показываются часы.</dd></div>
        <div><dt>Ночные смены и часовые пояса</dt><dd>Смена целиком относится к местной дате планового начала своей точки. Продолжительность считается между реальными моментами времени.</dd></div>
      </dl>
      <p className="work-time-footnote">Закрытая версия табеля сохраняет данные и правила на момент фиксации.</p>
      <footer><button type="button" className="app-primary" onClick={close}>Понятно</button></footer>
    </DocumentDialog>}</AnimatedOverlay>}
  </>;
}
