import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { canAccess } from '../../../app/access/catalog.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import { useMyUpcomingShifts } from '../../../app/schedule/queries.ts'
import { displayDate, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import HelpTip from '../../../component/ui/help-tip/help-tip.tsx'
import { ShiftOfferForm, ShiftOffersPanel } from '../schedule/shift-offers.tsx'
import DocumentDialog from '../documents/document-dialog.tsx'
import AnimatedOverlay from '../schedule/animated-overlay.tsx'

export default function RequestOffers({ organization }: { organization: OrganizationSummary }) {
  const [params, setParams] = useSearchParams(), [choosing, setChoosing] = useState(false), [shift, setShift] = useState<WorkShift | null>(null)
  const create = canAccess(organization, 'offers.transfer') || canAccess(organization, 'offers.swap')
  const upcoming = useMyUpcomingShifts(organization.id, choosing && create)
  function selectOffer(id: string | null) { setParams(current => { const next = new URLSearchParams(current); next.set('tab', 'offers'); if (id) next.set('offer', id); else next.delete('offer'); return next }) }
  return <div className="request-offers"><header className="requests-subheading"><h2>Передача и обмен<HelpTip label="О передаче и обмене">Выберите свою будущую смену, чтобы предложить её коллеге или обменять на другую. Здесь же можно ответить на предложение и согласовать обмен.</HelpTip></h2>{create && <button className="app-primary" onClick={() => setChoosing(true)}>Предложить смену</button>}</header>
    <ShiftOffersPanel organization={organization} embedded offerId={params.get('offer')} onOffer={selectOffer} onClose={() => selectOffer(null)}/>
    {choosing && <AnimatedOverlay variant="modal" onClose={() => setChoosing(false)}>{close => <DocumentDialog className="request-form-dialog" title="Какую смену предложить?" eyebrow="Заявки" onClose={close}>{upcoming.isLoading ? <p className="app-state">Загружаем ваши смены…</p> : upcoming.isError ? <div className="app-state"><p>Не удалось загрузить смены.</p><button className="app-secondary" onClick={() => void upcoming.refetch()}>Повторить</button></div> : <div className="request-offer-shift-picker">{upcoming.data?.shifts.filter(item => item.status === 'SCHEDULED' && new Date(item.scheduledStartAt) > new Date()).map(item => <button key={item.id} className="app-secondary" onClick={() => { setChoosing(false); setShift(item) }}><strong>{displayDate(zonedDateAndTime(item.scheduledStartAt, organization.timezone).date)}</strong><span>{shiftTimeRange(item.scheduledStartAt, item.scheduledEndAt, organization.timezone)}</span><small>{item.positionName ?? 'Смена'}</small><span aria-hidden="true">›</span></button>)}{!upcoming.data?.shifts.some(item => item.status === 'SCHEDULED' && new Date(item.scheduledStartAt) > new Date()) && <p className="app-state">У вас пока нет будущих смен для передачи или обмена.</p>}</div>}</DocumentDialog>}</AnimatedOverlay>}
    {shift && <ShiftOfferForm organization={organization} shift={shift} onClose={() => setShift(null)} onCreated={selectOffer}/>}
  </div>
}
