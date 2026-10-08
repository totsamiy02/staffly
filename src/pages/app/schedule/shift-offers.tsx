import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import { invalidateOrganizationWork } from '../../../app/live-query.ts'
import type { OrganizationSummary } from '../../../app/organizations/types.ts'
import type { WorkShift } from '../../../app/schedule/types.ts'
import { displayDate, formatDuration, shiftTimeRange, zonedDateAndTime } from '../../../app/schedule/date-utils.ts'
import { useOffer, useOffers, useOfferCandidates, useOfferSettings, offerStatus, type ShiftOffer, type OfferShift, type OfferTab, type OfferMode } from '../../../app/schedule/offers.ts'
import Avatar from '../../../component/ui/avatar/avatar.tsx'
import Select from '../../../component/ui/select/select.tsx'
import SegmentedNav from '../../../component/ui/segmented-nav/segmented-nav.tsx'
import { useToast } from '../../../component/ui/toast/toast-context.ts'
import DocumentDialog from '../documents/document-dialog.tsx'
import AnimatedOverlay from './animated-overlay.tsx'
import EmployeePicker from './employee-picker.tsx'
import './shift-offers.scss'

export function OfferShiftCard({ shift, locationName, label, tone }: { shift: OfferShift; locationName: string; label?: string; tone?: string }) {
  const date = zonedDateAndTime(shift.startAt, shift.timezone).date
  // Staffly counts paid breaks in shift duration, as the calendar and statistics do.
  const minutes = Math.max(0, Math.floor((Date.parse(shift.endAt) - Date.parse(shift.startAt)) / 60000))
  return <section className={`offer-shift${tone ? ` offer-shift--${tone}` : ''}`}>
    {label && <div className="offer-shift__label">{label}</div>}
    <div className="offer-shift__body">
      <div className="offer-shift__date"><OfferIcon kind="calendar" /><strong>{displayDate(date)} <span>·</span> <time>{shiftTimeRange(shift.startAt, shift.endAt, shift.timezone)}</time></strong></div>
      <div className="offer-shift__location"><OfferIcon kind="location" /><span>{locationName}</span></div>
      <div className="offer-shift__meta"><OfferIcon kind="work" /><span>{shift.positionName ?? 'Без должности'} · {formatDuration(minutes)}{shift.breakMinutes > 0 && ` · перерыв ${shift.breakMinutes} мин`}<small>{shift.timezone}</small></span></div>
      {shift.description && <p className="offer-shift__description">{shift.description}</p>}
    </div>
  </section>
}
function OfferIcon({ kind }: { kind: 'calendar' | 'location' | 'work' | 'send' | 'swap' | 'person' | 'people' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'calendar' ? <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v5m8-5v5M4 11h16" /></> : kind === 'location' ? <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2" /></> : kind === 'work' ? <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V4h8v3M3 12h18m-11 0v3h4v-3" /></> : kind === 'send' ? <><path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3" /></> : kind === 'swap' ? <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></> : <><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Z" />{kind === 'people' && <path d="M16 4a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5v2h-3" />}</>}
  </svg>
}
function ShiftComparison({ offer, ownMemberId }: { offer: ShiftOffer; ownMemberId?: string }) {
  if (!offer.target) return <OfferShiftCard shift={offer.source} locationName={offer.location.name} />
  const initiator = ownMemberId === offer.initiator.id
  const participant = initiator || ownMemberId === offer.recipient?.id
  return <div className="offer-comparison"><OfferShiftCard shift={initiator ? offer.source : offer.target} locationName={offer.location.name} label={participant ? "Вы отдаёте" : offer.recipient?.name} tone="out" /><span className="offer-comparison__arrow" aria-hidden="true">⇄</span><OfferShiftCard shift={initiator ? offer.target : offer.source} locationName={offer.location.name} label={participant ? "Вы получаете" : offer.initiator.name} tone="in" /></div>
}

export function ShiftOfferForm({ organization, shift, onClose, onCreated }: { organization: OrganizationSummary; shift: WorkShift; onClose: () => void; onCreated: (id: string) => void }) {
  const query = useOfferCandidates(organization.id, shift.id)
  const { apiRequest } = useAuth()
  const cache = useQueryClient(), toast = useToast()
  const [kind, setKind] = useState<'TRANSFER' | 'SWAP'>('TRANSFER')
  const [audience, setAudience] = useState<'person' | 'all'>('all')
  const [recipientId, setRecipientId] = useState(''), [targetId, setTargetId] = useState(''), [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const candidate = query.data?.candidates.find(c => c.id === recipientId)
  const target = candidate?.shifts.find(s => s.id === targetId)
  const settings = query.data
  const selectedMode = kind === 'TRANSFER' ? settings?.transferMode : settings?.swapMode
  const source: OfferShift = { id: shift.id, memberId: shift.memberId, locationId: organization.locationId!, startAt: shift.scheduledStartAt, endAt: shift.scheduledEndAt, timezone: organization.timezone, positionId: shift.positionId ?? null, positionName: shift.positionName ?? null, breakMinutes: shift.breakMinutes, description: shift.description }
  const unavailable = selectedMode === 'DISABLED' || !settings || (kind === 'TRANSFER' && audience === 'person' ? !candidate || !!candidate.transferReason : kind === 'SWAP' ? !target || !!target.reason : !settings.candidates.some(c => !c.transferReason))
  async function submit(event: FormEvent) {
    event.preventDefault(); if (unavailable || busy) return
    setBusy(true); setError('')
    try {
      const result = await apiRequest<{ offer: ShiftOffer }>(`/organizations/${organization.id}/schedule/offers`, { method: 'POST', body: { sourceShiftId: shift.id, kind, recipientMemberId: kind === 'SWAP' || audience === 'person' ? recipientId : null, targetShiftId: kind === 'SWAP' ? targetId : null, comment: comment.trim() || null } })
      await invalidateOrganizationWork(cache, organization.id); toast('Предложение отправлено', 'success'); onCreated(result.offer.id); onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось отправить предложение.'); await invalidateOrganizationWork(cache, organization.id) }
    finally { setBusy(false) }
  }
  return <AnimatedOverlay variant="modal" className="shift-offer-overlay" onClose={onClose} dismissible={!busy}>{close => <DocumentDialog title="Передать или обменять" eyebrow="" className="shift-offer-dialog shift-offer-dialog--form" onClose={close} busy={busy}><form className="shift-offer-form" onSubmit={event => void submit(event)}>
    <OfferShiftCard shift={source} locationName={organization.location?.name ?? 'Точка'} label={kind === 'SWAP' ? 'Вы отдаёте' : 'Ваша смена'} tone={kind === 'SWAP' ? 'out' : undefined} />
    {query.isLoading ? <div className="app-state"><span className="app-spinner" />Подбираем коллег…</div> : query.isError ? <div className="app-state" role="alert">{query.error.message}<button type="button" className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div> : <>
      <div className="offer-operation"><SegmentedNav label="Передача или обмен"><button type="button" aria-pressed={kind === 'TRANSFER'} disabled={busy} onClick={() => { setKind('TRANSFER'); setTargetId('') }}><OfferIcon kind="send" />Передать смену</button><button type="button" aria-pressed={kind === 'SWAP'} disabled={busy} onClick={() => setKind('SWAP')}><OfferIcon kind="swap" />Обменяться</button></SegmentedNav></div>
      {selectedMode === 'DISABLED' ? <p className="offer-note">{kind === 'TRANSFER' ? 'Передача смен' : 'Обмен сменами'} выключена владельцем.</p> : <>
        {kind === 'TRANSFER' && <div className="offer-field offer-audience"><span>Кому предложить</span><SegmentedNav label="Адресат предложения"><button type="button" aria-pressed={audience === 'person'} disabled={busy} onClick={() => setAudience('person')}><OfferIcon kind="person" />Коллеге</button><button type="button" aria-pressed={audience === 'all'} disabled={busy} onClick={() => setAudience('all')}><OfferIcon kind="people" />Всем в точке</button></SegmentedNav>{audience === 'all' && <small>Предложение увидят подходящие сотрудники этой точки.</small>}</div>}
        {(kind === 'SWAP' || audience === 'person') && <EmployeePicker label="Коллега" emptyLabel="Выберите коллегу" disabled={busy} value={recipientId} onChange={id => { setRecipientId(id); setTargetId('') }} members={(settings?.candidates ?? []).map(c => ({ id: c.id, displayName: c.name, email: c.email, avatarUrl: c.avatarUrl, disabledReason: kind === 'TRANSFER' ? c.transferReason : !c.shifts.some(s => !s.reason) ? 'Нет подходящих смен для обмена' : null }))} />}
        {kind === 'SWAP' && <label><span>Смена коллеги</span><Select required disabled={!candidate || busy} value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">Выберите будущую смену</option>{candidate?.shifts.map(s => <option value={s.id} key={s.id} disabled={!!s.reason}>{displayDate(zonedDateAndTime(s.startAt, s.timezone).date)} · {shiftTimeRange(s.startAt, s.endAt, s.timezone)}{s.reason ? ' · недоступно' : ''}</option>)}</Select>{candidate && !candidate.shifts.some(s => !s.reason) && <small>Нет подходящих будущих смен для обмена.</small>}</label>}
        {target && <OfferShiftCard shift={target} locationName={organization.location?.name ?? 'Точка'} label="Вы получаете" tone="in" />}
        {target && !target.reason && <p className="offer-check">✓ Пересечений со сменами и отсутствиями нет</p>}
        {(target?.reason || kind === 'TRANSFER' && audience === 'person' && candidate?.transferReason) && <p className="form-inline-error" role="alert">{target?.reason ?? candidate?.transferReason}</p>}
        {kind === 'TRANSFER' && audience === 'all' && !settings?.candidates.some(c => !c.transferReason) && <p className="offer-note">В этой точке нет подходящих сотрудников для смены.</p>}
        <label><span>Комментарий <small>(необязательно)</small></span><textarea value={comment} disabled={busy} onChange={e => setComment(e.target.value)} maxLength={500} rows={3} placeholder="Например, не смогу выйти" /></label>
        <p className="offer-note">До завершения {kind === 'SWAP' ? 'обмена' : 'передачи'} смена остаётся за вами.{selectedMode === 'APPROVAL' && ' После согласия коллеги потребуется согласование администратора.'}</p>
      </>}
    </>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
    <footer><button type="button" className="app-secondary" disabled={busy} onClick={close}>Назад</button><button className="app-primary" disabled={unavailable || busy}>{busy ? 'Отправляем…' : kind === 'SWAP' ? 'Предложить обмен' : 'Предложить смену'}</button></footer>
  </form></DocumentDialog>}</AnimatedOverlay>
}

function OfferPersonRow({ person, label }: { person: ShiftOffer['initiator']; label: string }) {
  return <div className="offer-person"><Avatar eager url={person.avatarUrl} name={person.name} className="offer-avatar" /><div><strong>{person.name}</strong><small>{label}</small></div></div>
}

function OfferCard({ offer, ownMemberId, detail = false, busy, onOpen, onAction }: { offer: ShiftOffer; ownMemberId?: string; detail?: boolean; busy?: boolean; onOpen?: () => void; onAction?: (action: string) => void }) {
  const mine = ownMemberId === offer.initiator.id
  const recipient = offer.acceptedBy ?? offer.recipient
  return <article className={`shift-offer-card${detail ? ' shift-offer-card--detail' : ''}`}>
    <header className="shift-offer-card__heading"><span>{offer.kind === 'SWAP' ? 'Взаимный обмен' : offer.recipient ? 'Передача коллеге' : 'Доступная смена'}</span><span className={`offer-status offer-status--${offer.status.toLowerCase()}`}>{offerStatus[offer.status]}</span></header>
    {detail ? <ShiftComparison offer={offer} ownMemberId={ownMemberId} /> : <OfferShiftCard shift={offer.source} locationName={offer.location.name} />}
    {detail ? <>
      <div className="offer-participants"><OfferPersonRow person={offer.initiator} label={mine ? 'Вы предложили смену' : 'Инициатор предложения'} />{recipient && <OfferPersonRow person={recipient} label={offer.acceptedBy ? 'Согласие получено' : 'Получатель предложения'} />}</div>
      {offer.comment && <p className="offer-comment">{offer.comment}</p>}
      {offer.resolutionReason && <p className={`offer-note${offer.status === 'COMPLETED' ? ' offer-check' : ''}`}>{offer.resolutionReason}</p>}
      {offer.acceptanceReason && <p className="offer-note">{offer.acceptanceReason}</p>}
      {offer.status === 'PENDING' && <p className="offer-note">{offer.mode === 'APPROVAL' ? 'После согласия коллеги потребуется подтверждение администратора.' : 'Назначения изменятся после согласия коллеги.'}</p>}
      {offer.status === 'AWAITING_APPROVAL' && <p className="offer-note">Коллега согласился. До подтверждения администратора назначения остаются прежними.</p>}
      <div className="offer-details-meta"><time dateTime={offer.createdAt}>Отправлено {new Date(offer.createdAt).toLocaleString('ru-RU', { timeZone: offer.source.timezone })}</time>{offer.reviewedBy && <span>Решение: {offer.reviewedBy.name}</span>}</div>
      {(offer.canCancel || offer.canReject || offer.canAccept || offer.canApprove) && <footer className="offer-detail-actions">
        {offer.canCancel && <button type="button" className="app-secondary" disabled={busy} onClick={() => onAction?.('cancel')}>Отменить предложение</button>}
        {offer.canReject && <button type="button" className="app-secondary" disabled={busy} onClick={() => onAction?.('reject')}>Отказаться</button>}
        {offer.canAccept && <button type="button" className="app-primary" disabled={busy} onClick={() => onAction?.('accept')}>{busy ? 'Проверяем…' : offer.kind === 'SWAP' ? 'Принять обмен' : 'Забрать смену'}</button>}
        {offer.canApprove && <><button type="button" className="app-secondary" disabled={busy} onClick={() => onAction?.('decline')}>Отклонить</button><button type="button" className="app-primary" disabled={busy} onClick={() => onAction?.('approve')}>{busy ? 'Проверяем…' : 'Подтвердить'}</button></>}
      </footer>}
    </> : <footer className="offer-list-actions"><OfferPersonRow person={offer.initiator} label={mine ? 'Ваше предложение' : offer.kind === 'SWAP' ? 'Предлагает обмен' : 'Предлагает смену'} /><button type="button" className="app-secondary" onClick={onOpen}>{offer.kind === 'SWAP' ? 'Посмотреть обмен' : 'Посмотреть'}</button></footer>}
  </article>
}

export function ShiftOffersPanel({ organization, offerId, onClose, onOffer }: { organization: OrganizationSummary; offerId: string | null; onClose: () => void; onOffer: (id: string | null) => void }) {
  const { apiRequest, locationId } = useAuth(), cache = useQueryClient()
  const [tab, setTab] = useState<OfferTab>('mine'), [page, setPage] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const list = useOffers(organization.id, tab, page), query = useOffer(organization.id, offerId)
  const ownMemberId = organization.viewerMemberId
  const offer = query.data?.offer
  const canManage = organization.role !== 'MEMBER'
  async function action(value: string) {
    if (!offer || busy) return
    setBusy(true); setError('')
    try {
      const updated = await apiRequest<{ offer: ShiftOffer }>(`/organizations/${organization.id}/schedule/offers/${offer.id}/action`, { method: 'POST', body: { action: value } })
      cache.setQueryData(['shift-offer', organization.id, locationId, offer.id], updated); await invalidateOrganizationWork(cache, organization.id)

    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Действие не выполнено.'); await invalidateOrganizationWork(cache, organization.id) }
    finally { setBusy(false) }
  }
  function selectOffer(id: string | null) { setError(''); onOffer(id) }
  return <AnimatedOverlay variant="modal" className="shift-offer-overlay" onClose={onClose} dismissible={!busy}>{close => <DocumentDialog key={`${offerId ?? 'list'}:${offer?.status ?? 'loading'}`} title={offerId ? offer?.kind === 'SWAP' ? 'Предложение обмена' : 'Предложение смены' : 'Предложения смен'} eyebrow="" className={`shift-offer-dialog${!offerId ? ' shift-offer-dialog--list' : ''}`} busy={busy} onClose={close}>
    {offerId ? <><button type="button" className="app-back" disabled={busy} onClick={() => selectOffer(null)}>Все предложения</button>{query.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем предложение…</div> : offer ? <><OfferCard offer={offer} ownMemberId={ownMemberId} detail busy={busy} onAction={v => void action(v)} />{offer.status === 'COMPLETED' && <Link className="app-secondary offer-open-shift" onClick={close} to={`/app/organizations/${organization.id}/schedule?location=${offer.location.id}&month=${zonedDateAndTime(offer.source.startAt, offer.source.timezone).date.slice(0, 7)}&shift=${offer.target && offer.initiator.id === ownMemberId ? offer.target.id : offer.source.id}`}>Открыть смену</Link>}</> : <div className="app-state" role="alert">{query.error?.message ?? 'Предложение недоступно.'}<button className="app-secondary" onClick={() => void query.refetch()}>Повторить</button></div>}</> : <>
      <SegmentedNav variant="underline" label="Разделы предложений">{([['mine', 'Мне'], ['available', 'Доступные'], ['sent', 'Отправленные'], ...(canManage ? [['approval', 'Согласование']] : [])] as Array<[OfferTab, string]>).map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setPage(1) }}>{label}{value !== 'sent' && !!list.data?.counts[value as keyof typeof list.data.counts] && <span className="offer-count">{list.data.counts[value as keyof typeof list.data.counts]}</span>}</button>)}</SegmentedNav>
      {list.isLoading ? <div className="app-state"><span className="app-spinner" />Загружаем предложения…</div> : list.isError ? <div className="app-state" role="alert">Не удалось загрузить предложения.<button className="app-secondary" onClick={() => void list.refetch()}>Повторить</button></div> : <><div className="shift-offer-list">{list.data?.offers.map(item => <OfferCard key={item.id} offer={item} ownMemberId={ownMemberId} onOpen={() => selectOffer(item.id)} />)}</div>{!list.data?.offers.length && <div className="offer-empty"><span className="offer-empty__icon"><OfferIcon kind="calendar" /></span><strong>{tab === 'mine' ? 'Входящих предложений пока нет' : tab === 'available' ? 'Доступных смен пока нет' : tab === 'sent' ? 'Вы ещё не предлагали смены' : 'Нет предложений для согласования'}</strong><p>{tab === 'sent' ? 'Откройте свою будущую смену и выберите «Передать или обменять».' : 'Новые предложения появятся здесь.'}</p></div>}{list.data && list.data.pagination.pages > 1 && <nav className="shift-history__pagination" aria-label="Страницы предложений"><button disabled={page === 1 || list.isFetching} onClick={() => setPage(p => p - 1)}>Назад</button><span>{page} из {list.data.pagination.pages}</span><button disabled={page === list.data.pagination.pages || list.isFetching} onClick={() => setPage(p => p + 1)}>Далее</button></nav>}</>}
    </>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}{busy && <p role="status" className="offer-note">Сохраняем и проверяем расписание…</p>}
  </DocumentDialog>}</AnimatedOverlay>
}

export function ShiftOfferSettings({ organization }: { organization: OrganizationSummary }) {
  const query = useOfferSettings(organization.id), { apiRequest } = useAuth(), cache = useQueryClient(), toast = useToast()
  const [transfer, setTransfer] = useState<OfferMode | null>(null), [swap, setSwap] = useState<OfferMode | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const modeOptions = <><option value="DISABLED">Выключено</option><option value="AUTO">Автоматически</option><option value="APPROVAL">С согласованием</option></>
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await apiRequest(`/organizations/${organization.id}/schedule/offer-settings`, { method: 'PUT', body: { transferMode: transfer ?? query.data?.transferMode, swapMode: swap ?? query.data?.swapMode } }); await invalidateOrganizationWork(cache, organization.id); setTransfer(null); setSwap(null); toast('Настройки передачи и обмена сохранены', 'success') }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.') }
    finally { setBusy(false) }
  }
  return <section className="shift-offer-settings"><h3>Передача и обмен сменами</h3><p>Сотрудники могут предложить свою будущую смену коллегам в той же точке. Передача и обмен настраиваются отдельно для всей организации.</p>{query.isLoading ? <div className="app-state"><span className="app-spinner" /></div> : query.isError ? <div className="app-state">Не удалось загрузить настройки.<button onClick={() => void query.refetch()}>Повторить</button></div> : <form onSubmit={e => void submit(e)}><div className="shift-offer-settings__fields"><label><span>Передача смены</span><Select value={transfer ?? query.data?.transferMode ?? 'DISABLED'} disabled={busy} onChange={e => setTransfer(e.target.value as OfferMode)}>{modeOptions}</Select></label><label><span>Обмен сменами</span><Select value={swap ?? query.data?.swapMode ?? 'DISABLED'} disabled={busy} onChange={e => setSwap(e.target.value as OfferMode)}>{modeOptions}</Select></label></div><p className="offer-note">«С согласованием»: после согласия коллеги решение принимает владелец или администратор точки, не участвующий в операции. При изменении режима незавершённые предложения этого вида закроются.</p>{error && <p className="form-inline-error" role="alert">{error}</p>}<button className="app-primary" disabled={busy || transfer === null && swap === null}>{busy ? 'Сохраняем…' : 'Сохранить режимы'}</button></form>}</section>
}
