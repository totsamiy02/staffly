import { lazy, Suspense, useState } from 'react'
import { useSubscription } from '../../../../app/subscriptions/context.ts'
import type { OrganizationSummary } from '../../../../app/organizations/types.ts'
import AnimatedOverlay from '../../../../component/ui/modal/animated-overlay.tsx'
import TimesheetDisclosure from './timesheet-disclosure.tsx'

const ReportDialog = lazy(() => import('../reports/report-dialog.tsx'))

export default function TimesheetReports({ organization, month, compact = false }: {
  organization: OrganizationSummary
  month: string
  compact?: boolean
}) {
  const subscription = useSubscription()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const content = (
    <div className="timesheet-report-entry">
      <div>
        <h3>Отчёт по текущим данным</h3>
        <p>Выберите период, сотрудников и столбцы, проверьте предпросмотр и скачайте Excel. Отчёт обновляется вместе с расписанием.</p>
        {!compact && <small>Фиксация неизменяемой версии месяца доступна на тарифе «Бизнес».</small>}
      </div>
      <button type="button" className={compact ? 'app-secondary' : 'app-primary'} onClick={() => {
        if (subscription.available('reports')) setOpen(true)
        else subscription.request({ feature: 'reports' })
      }}>Открыть предпросмотр</button>
    </div>
  )

  return (
    <>
      {compact ? <TimesheetDisclosure title="Настраиваемые отчёты">{content}</TimesheetDisclosure> : content}
      {open && subscription.available('reports') && (
        <AnimatedOverlay variant="modal" dismissible={!busy} onClose={() => setOpen(false)}>
          {close => (
            <Suspense fallback={<div className="route-loading" role="status">Загружаем отчёт…</div>}>
              <ReportDialog organization={organization} month={month} onClose={close} onBusy={setBusy} />
            </Suspense>
          )}
        </AnimatedOverlay>
      )}
    </>
  )
}
