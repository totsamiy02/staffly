import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Isolated test browser, disposable users/database, synthetic purchases only.
export async function runUiSmoke({ prisma, owner, org, origin, port, output, connect }) {
  const { createOrganization } = await import('../../src/server/organizations/organization-service.ts')
  const free = await createOrganization(owner.id, { name: 'Пробный тариф — тестовая команда', description: 'Работаем вместе каждый день.', timezone: 'Europe/Moscow' })
  const extraOrganizations = []
  for (let i = 0; i < 2; i++) extraOrganizations.push(await createOrganization(owner.id, { name: `Ещё одна команда ${i + 1}`, description: null, timezone: 'Europe/Moscow' }))
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = await connect(target.webSocketDebuggerUrl), errors = [], checks = [], screenshots = [], bodies = []
  const evaluate = async expression => {
    const value = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  }
  const wait = async (expression, label) => {
    const until = Date.now() + 30000
    while (Date.now() < until) { if (await evaluate(expression)) return; await delay(80) }
    throw new Error(`UI timeout: ${label}; ` + await evaluate('document.body.innerText.slice(-2500)'))
  }
  const navigate = async (route, selector) => {
    await cdp.call('Page.navigate', { url: origin + route })
    await wait(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector('.app-loading,.route-loading')`, route)
    if (await evaluate("document.body.innerText.includes('Мы используем cookie')")) { await click('Только необходимые'); await wait("!document.body.innerText.includes('Мы используем cookie')", 'Cookie choice') }
    await delay(250)
  }
  const click = async text => {
    assert(await evaluate(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled);if(!e)return false;e.click();return true})()`), 'Missing enabled control: ' + text)
  }
  const shot = async name => {
    await delay(450)
    const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(output, name + '.png'); await writeFile(file, Buffer.from(image.data, 'base64')); screenshots.push(file)
  }
  const checkOrganizationRows = async () => {
    const centered = await evaluate("[...document.querySelectorAll('.organization-grid')].every(grid=>{const parent=grid.getBoundingClientRect(),rows=new Map();for(const card of grid.querySelectorAll('.organization-card')){const r=card.getBoundingClientRect(),key=Math.round(r.top),row=rows.get(key)||{left:r.left,right:r.right};row.left=Math.min(row.left,r.left);row.right=Math.max(row.right,r.right);rows.set(key,row)}return [...rows.values()].every(row=>Math.abs((row.left+row.right)/2-parent.left-parent.width/2)<1)})")
    assert(centered, 'Organization cards must be centered as a row within their group')
  }
  try {
    cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text))
    cdp.on('Network.requestWillBeSent', event => { if (event.request.url.includes('/test-activation')) bodies.push(JSON.parse(event.request.postData)) })
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable')
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('staffly.theme','light');localStorage.removeItem('staffly:sidebar-collapsed')" })
    const raw = randomUUID() + randomUUID()
    await prisma.authSession.create({ data: { userId: owner.id, refreshTokenHash: createHash('sha256').update(raw).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
    await cdp.call('Network.clearBrowserCookies')
    await cdp.call('Network.setCookie', { name: 'staffly_refresh', value: raw, url: origin + '/api/auth', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })
    for (const width of [320, 390, 768, 1024, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
      for (const [name, route, selector] of [['home', '/', '.hero__actions'], ['organizations', '/app', '.organization-card'], ['plans', `/app/organizations/${free.id}/settings?section=subscription`, '.subscription-plans']]) {
        await navigate(route, selector)
        assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), `${width}px overflow: ${name}`)
        if (name === 'home') {
          assert.equal(await evaluate("[...document.querySelectorAll('.hero__actions button')].map(e=>e.textContent).join('|')"), 'Мои организации|Создать организацию')
          assert.equal(await evaluate("document.querySelectorAll('.header__navigation,.header__workspace-link,.hero__tariff-link,.footer__database-check').length"), 0)
          assert(await evaluate("![...document.querySelectorAll('.site-header a,.site-header button')].some(e=>e.textContent.trim()==='Мои организации')"), 'No duplicate organization link in header')
          assert(await evaluate("!!document.querySelector('.footer a[href=\"/#pricing\"]')"))
        }
        if (name === 'organizations') assert(await evaluate("[...document.querySelectorAll('.organization-card')].every(e=>{const r=e.getBoundingClientRect(),a=e.querySelector('.organization-card__avatar').getBoundingClientRect();return r.width<=360&&Math.abs(r.x+r.width/2-a.x-a.width/2)<1&&e.scrollWidth<=e.clientWidth+1})"), 'Centered organization cards must fit their cells')
        if (name === 'organizations') await checkOrganizationRows()
        if (name === 'plans') {
          assert(await evaluate("!!document.querySelector('.subscription-trial-button')"), 'Manual trial missing')
          await evaluate("document.querySelector('.subscription-plans').scrollIntoView({block:'start',behavior:'instant'})")
        }
        await shot(`${name}-${width}`)
      }
    }
    checks.push('320/390/768/1024/1440px: landing navigation, centered organization cards and plan cards have no horizontal overflow')
    const layoutOwner = await prisma.user.create({ data: { email: `layout-${randomUUID()}@example.test`, firstName: 'Тест', lastName: 'Команды', passwordHash: owner.passwordHash, emailVerifiedAt: new Date() } })
    const layoutSession = randomUUID() + randomUUID()
    await prisma.authSession.create({ data: { userId: layoutOwner.id, refreshTokenHash: createHash('sha256').update(layoutSession).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
    await cdp.call('Network.clearBrowserCookies')
    await cdp.call('Network.setCookie', { name: 'staffly_refresh', value: layoutSession, url: origin + '/api/auth', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })
    for (const count of [1, 2]) {
      await createOrganization(layoutOwner.id, { name: `Команда ${count}`, description: null, timezone: 'Europe/Moscow' })
      for (const width of [390, 1440]) {
        await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
        await navigate('/app', '.organization-card')
        await wait(`document.querySelectorAll('.organization-card').length===${count}`, 'Organization count layout')
        assert(await evaluate("[...document.querySelectorAll('.organization-card')].every(e=>{const r=e.getBoundingClientRect(),a=e.querySelector('.organization-card__avatar').getBoundingClientRect();return r.width<=360&&Math.abs(r.x+r.width/2-a.x-a.width/2)<1&&e.scrollWidth<=e.clientWidth+1})"))
        if (count === 1 && width === 1440) assert(await evaluate("document.querySelector('.organization-card').getBoundingClientRect().width<document.querySelector('.organization-grid').getBoundingClientRect().width/2"), 'Single organization must keep normal card width')
        await checkOrganizationRows()
        await shot(`centered-organizations-${count}-${width}`)
        if (count === 1 && width === 1440) {
          await evaluate("localStorage.setItem('staffly.theme','dark');window.dispatchEvent(new StorageEvent('storage',{key:'staffly.theme',newValue:'dark'}))")
          await wait("document.documentElement.dataset.theme==='dark'", 'Dark centered card')
          await shot('centered-organization-dark')
        }

      }
    }
    const { createCodeInvitation, acceptCodeInvitation } = await import('../../src/server/organizations/invitation-service.ts')
    const invitation = await createCodeInvitation(owner.id, extraOrganizations[0].id)
    await acceptCodeInvitation(layoutOwner.id, layoutOwner.email, invitation.code)
    await navigate('/app', '.organization-card')
    await wait("document.querySelectorAll('.organizations-section').length===2", 'Created and invited groups')
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.organizations-section h2')].map(e=>e.textContent)"), ['Созданные вами', 'Вас пригласили'])
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.organizations-section')].map(e=>e.querySelectorAll('.organization-card').length)"), [2, 1])
    await shot('created-and-invited-organizations')
    const restoredSession = randomUUID() + randomUUID()
    await prisma.authSession.create({ data: { userId: owner.id, refreshTokenHash: createHash('sha256').update(restoredSession).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
    await cdp.call('Network.clearBrowserCookies')
    await cdp.call('Network.setCookie', { name: 'staffly_refresh', value: restoredSession, url: origin + '/api/auth', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })
    checks.push('one/two/four organization cards keep centered photos and compact widths without stretching')
    await navigate(`/app/organizations/${free.id}/schedule`, '.schedule-navigation')
    await evaluate("[...document.querySelectorAll('.schedule-navigation__tools button')].find(e=>e.textContent.includes('Выгрузка Excel')).click()")
    await wait("!!document.querySelector('.subscription-gate')", 'Feature upgrade dialog')
    await delay(300)
    const overlayGeometry = await evaluate("(()=>{const e=document.querySelector('.subscription-gate').closest('.schedule-modal'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:[innerWidth,innerHeight,document.documentElement.clientWidth],position:s.position,transform:s.transform,parent:e.parentElement.tagName}})()")
    await writeFile(path.join(output, 'overlay-geometry.json'), JSON.stringify(overlayGeometry))
    assert(Math.abs(overlayGeometry.x)<1 && Math.abs(overlayGeometry.y)<1 && overlayGeometry.width>=overlayGeometry.viewport[2]-1 && Math.abs(overlayGeometry.height-overlayGeometry.viewport[1])<1, 'Dialog overlay must cover the entire viewport: '+JSON.stringify(overlayGeometry))
    await shot('feature-gate-desktop')
    await click('Не сейчас')
    await wait("!document.querySelector('.subscription-gate')", 'Close upgrade dialog')
    await navigate(`/app/organizations/${free.id}/settings?section=subscription`, '.subscription-plans')
    // Trial is a deliberate confirmation, never a side effect of entering an org.
    assert.equal((await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: free.id } })).plan, 'FREE')
    await evaluate("document.querySelector('.subscription-trial-button').click()")
    await wait("!!document.querySelector('.subscription-trial-preview')", 'Trial confirmation')
    await shot('trial-confirmation')
    await click('Начать пробный период')
    await wait("!document.querySelector('.subscription-trial-preview')&&!document.querySelector('.subscription-trial-button')", 'Trial activation')
    assert.equal((await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: free.id } })).plan, 'BUSINESS')
    assert.equal(await evaluate("document.querySelectorAll('.workspace-content>.subscription-banner,.workspace-content>div>.subscription-banner').length"), 0)
    await evaluate("document.querySelector('button[aria-label^=\"Уведомления\"]').click()")
    await wait("!!document.querySelector('button[aria-label=\"Закрыть уведомление о тарифе\"]')", 'Owner inbox notice')
    await shot('trial-notification')
    await evaluate("document.querySelector('button[aria-label=\"Закрыть уведомление о тарифе\"]').click()")
    await wait("!document.querySelector('button[aria-label=\"Закрыть уведомление о тарифе\"]')", 'Dismiss subscription notice')
    await navigate(`/app/organizations/${free.id}/settings?section=subscription`, '.subscription-plans')
    assert.equal(await prisma.accountNotification.count({ where: { organizationId: free.id, type: 'SUBSCRIPTION_STATUS', hiddenAt: null } }), 0)
    checks.push('manual one-time trial activates only its organization; owner notice is in the inbox and dismissal persists')
    await click('Выбрать бесплатный'); await click('Подтвердить переход')
    await wait("document.querySelector('.subscription-current h3')?.textContent==='Бесплатный'", 'Free plan')
    await click('Выбрать Команду')
    await wait("!!document.querySelector('input[name=number]')", 'Checkout')
    await click('Купить за 990 ₽')
    await wait("!!document.querySelector('#card-error-number')", 'Card validation')
    await click('Заполнить тестовые данные')
    await evaluate("document.querySelector('input[name=confirm]').click()")
    await shot('checkout-desktop')
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'Mobile checkout overflow')
    await shot('checkout-mobile')
    await click('Купить за 990 ₽')
    await wait("!!document.querySelector('.subscription-success')", 'Test purchase success')
    assert.equal(bodies.length, 1); assert.deepEqual(Object.keys(bodies[0]).sort(), ['confirm', 'email', 'mode'])
    assert.equal((await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: free.id } })).plan, 'TEAM')
    assert.equal((await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: org.id } })).plan, 'BUSINESS')
    await shot('purchase-success-mobile')
    checks.push('checkout validates fields, activates Team for the selected organization, and sends no card data')
    // The system folder is a live view over original request attachments.
    const { createRequestType } = await import('../../src/server/requests/type-service.ts')
    const { createRequest, submitRequest } = await import('../../src/server/requests/request-submission.ts')
    const { addRequestAttachment } = await import('../../src/server/requests/attachment-service.ts')
    const type = await createRequestType(owner.id, free.id, { name: 'Файлы для команды', dateMode: 'NONE', requiresComment: false, allowsAttachments: true })
    const request = await createRequest(owner.id, free.id, { requestTypeId: type.id, draft: true })
    await addRequestAttachment(owner.id, free.id, request.id, Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf', 'Заявление.pdf'); await submitRequest(owner.id, free.id, request.id)
    for (const width of [390, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      await navigate(`/app/organizations/${free.id}/documents`, '.document-system-folder')
      await evaluate("document.querySelector('.document-system-folder button').click()")
      await wait("document.querySelector('.request-file-row__name strong')?.textContent==='Заявление.pdf'", 'Original request file appears in system folder')
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
      await shot(`request-files-${width}`)
    }
    await prisma.organizationRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', resolvedAt: new Date() } })
    await evaluate("document.querySelector('.request-file-row__name a').click()")
    await wait("!!document.querySelector('.request-detail-dialog .request-detail-main')", 'Source request opens from file folder')
    assert(await evaluate("!document.querySelector('.request-extra-operations')"), 'No empty operations block')
    assert(await evaluate("!document.querySelector('.request-detail-actions')"), 'Closed requests do not reserve an empty action column')
    await shot('request-detail-compact')
    await navigate(`/app/organizations/${free.id}/settings?section=requests`, '.holiday-editor__toggle')
    assert(await evaluate("document.querySelector('.holiday-editor__toggle').getAttribute('aria-expanded')==='false'"))
    await evaluate("document.querySelector('.holiday-editor__toggle').click()")
    await delay(350)
    assert(await evaluate("document.querySelector('.holiday-editor__toggle').getAttribute('aria-expanded')==='true'"))
    await shot('holidays-expanded')
    await navigate(`/app/organizations/${free.id}/settings`, '.organization-profile-editor')
    assert(await evaluate("document.querySelector('.organization-profile-editor .profile-details--prose .profile-field-value').getBoundingClientRect().height<70"), 'Short organization description must stay compact')
    const readFields = await evaluate("[...document.querySelectorAll('.organization-profile-editor .profile-details dd')].map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y}))")
    await click('Редактировать')
    await wait("!!document.querySelector('.profile-details--editing')", 'Edit organization fields')
    const editFields = await evaluate("[...document.querySelectorAll('.organization-profile-editor .profile-details dd')].map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y}))")
    assert.equal(readFields.length, editFields.length)
    readFields.forEach((value, i) => { assert(Math.abs(value.x-editFields[i].x)<1); assert(Math.abs(value.y-editFields[i].y)<1, `Organization field moved at ${i}: ${JSON.stringify([value,editFields[i]])}`) })
    assert(await evaluate("document.querySelector('textarea[aria-label=\"Информация для команды\"]').getBoundingClientRect().height<70"), 'Short description editor must stay compact')
    await shot('organization-fields-edit')
    await click('Отмена')
    checks.push('request attachment system folder on mobile/desktop and stable organization edit fields')
    // Existing fixture has eight points; exercise ten, then the two-point chips.
    for (let i = 9; i <= 10; i++) await prisma.organizationLocation.create({ data: { organizationId: org.id, name: `Точка ${i} — длинное название`, city: 'Москва', address: `Примерная, ${i}`, timezone: 'Europe/Moscow' } })
    for (const width of [390, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
      await navigate(`/app/organizations/${org.id}`, '.dashboard-scope-picker .location-switcher__trigger')
      assert(await evaluate("document.querySelector('.dashboard-scope-picker').textContent.includes('10 точек')"))
      await evaluate("document.querySelector('.dashboard-scope-picker .location-switcher__trigger').click()")
      await wait("document.querySelectorAll('.dashboard-scope-picker .location-switcher__list button').length===11", 'Ten locations + all')
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
      await shot(`ten-locations-${width}`)
    }
    const pointOptions = await prisma.organizationLocation.findMany({ where: { organizationId: org.id, archivedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const sidebarPoint = pointOptions.find(point => point.id === org.locationId), dashboardPoint = pointOptions.find(point => point.id !== org.locationId), thirdPoint = pointOptions.find(point => point.id !== org.locationId && point.id !== dashboardPoint.id)
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await navigate(`/app/organizations/${org.id}?location=${sidebarPoint.id}&dashboardPoint=all`, '.dashboard-scope-picker')
    await evaluate("document.querySelector('.dashboard-scope-picker .location-switcher__trigger').click()")
    await evaluate(`[...document.querySelectorAll('.dashboard-scope-picker .location-switcher__list button')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(dashboardPoint.name)}).click()`)
    await wait(`new URL(location.href).searchParams.get('dashboardPoint')===${JSON.stringify(dashboardPoint.id)}`, 'Dashboard point filter')
    assert.equal(await evaluate("new URL(location.href).searchParams.get('location')"), sidebarPoint.id)
    assert.equal(await evaluate(`sessionStorage.getItem(${JSON.stringify(`staffly:location:${owner.id}:${org.id}`)})`), sidebarPoint.id)
    assert.equal(await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger strong').textContent"), sidebarPoint.name)
    assert(await evaluate(`[...document.querySelectorAll('.workspace-sidebar>nav a')].every(e=>new URL(e.href).searchParams.get('location')===${JSON.stringify(sidebarPoint.id)})`))
    await shot('independent-dashboard-point')
    await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
    await evaluate(`[...document.querySelectorAll('.workspace-sidebar .location-switcher__list button')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(thirdPoint.name)}).click()`)
    await wait(`document.querySelector('.workspace-sidebar .location-switcher__trigger strong')?.textContent===${JSON.stringify(thirdPoint.name)}`, 'Sidebar point filter')
    assert.equal(await evaluate("new URL(location.href).searchParams.get('dashboardPoint')"), dashboardPoint.id)
    await wait(`document.querySelector('.dashboard-scope-picker .location-switcher__trigger strong')?.textContent===${JSON.stringify(dashboardPoint.name)}`, 'Dashboard keeps its point after sidebar reload')
    await evaluate("document.querySelector('.dashboard-scope-picker .location-switcher__trigger').click()")
    await evaluate("[...document.querySelectorAll('.dashboard-scope-picker .location-switcher__list button')].find(e=>e.querySelector('strong')?.textContent==='Вся организация').click()")
    assert.equal(await evaluate("new URL(location.href).searchParams.get('location')"), thirdPoint.id)
    await evaluate("[...document.querySelectorAll('.workspace-sidebar>nav a')].find(e=>e.textContent.includes('Расписание')).click()")
    await wait("!!document.querySelector('.schedule-navigation')", 'Sidebar schedule navigation')
    assert.equal(await evaluate("new URL(location.href).searchParams.get('location')"), thirdPoint.id)
    checks.push('dashboard point filter and sidebar context remain independent in both directions and module navigation uses sidebar point')
    for (const height of [500, 600, 760, 900]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false })
      await navigate(`/app/organizations/${org.id}`, '.workspace-sidebar')
      const geometry = await evaluate("(()=>{const s=document.querySelector('.workspace-sidebar'),f=s.querySelector('.workspace-sidebar__footer');return {scroll:s.scrollHeight,height:s.clientHeight,footer:f.getBoundingClientRect().bottom,nav:s.querySelector('nav').getBoundingClientRect().top}})()")
      assert(geometry.footer<=height+1, `Sidebar footer outside ${height}px viewport: ${JSON.stringify(geometry)}`)
      assert(geometry.scroll<=geometry.height+1, `Sidebar scrolls at ${height}px: ${JSON.stringify(geometry)}`)
      await evaluate("document.querySelector('.workspace-sidebar__collapse').click()")
      await delay(300)
      const collapsedTop = await evaluate("document.querySelector('.workspace-sidebar>nav').getBoundingClientRect().top")
      assert(Math.abs(collapsedTop-geometry.nav)<1, 'Sidebar rows jump vertically on collapse: '+JSON.stringify({height,before:geometry,after:collapsedTop}))
      await shot(`sidebar-collapsed-${height}`)
      await evaluate("document.querySelector('.workspace-sidebar__collapse').click()")
      await delay(300)
    }
    checks.push('sidebar stays inside 500/600/760/900px viewports with ten locations and collapse keeps navigation row positions')
    await navigate(`/app/organizations/${org.id}/employees`, '.member-more')
    await evaluate("document.querySelectorAll('.member-more')[1].click()")
    await evaluate("[...document.querySelectorAll('.member-actions-menu button')].find(e=>e.textContent.includes('Назначить в точку')).click()")
    await wait("!!document.querySelector('.member-assignment-dialog')", 'Compact point assignment dialog')
    await shot('member-assignment-dialog')
    await click('Отмена')
    await wait("!document.querySelector('.member-assignment-dialog')", 'Close assignment')
    const { saveOfferModes, createOffer } = await import('../../src/server/schedule/offer-service.ts')
    await saveOfferModes(owner.id, org.id, { transferMode: 'AUTO', swapMode: 'AUTO' })
    const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
    const sourceShifts = await prisma.workShift.findMany({ where: { organizationId: org.id, locationId: org.locationId, memberId: { not: ownerMember.id }, status: 'SCHEDULED', scheduledStartAt: { gt: new Date() } }, take: 2, include: { member: true } })
    assert.equal(sourceShifts.length, 2)
    await createOffer(sourceShifts[0].member.userId, org.id, { sourceShiftId: sourceShifts[0].id, kind: 'TRANSFER', recipientMemberId: ownerMember.id, targetShiftId: null, comment: null })
    const targetShift = await prisma.workShift.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: ownerMember.id, createdByMemberId: ownerMember.id, scheduledStartAt: new Date(+sourceShifts[1].scheduledStartAt + 9*3600000), scheduledEndAt: new Date(+sourceShifts[1].scheduledEndAt + 9*3600000) } })
    await createOffer(sourceShifts[1].member.userId, org.id, { sourceShiftId: sourceShifts[1].id, kind: 'SWAP', recipientMemberId: ownerMember.id, targetShiftId: targetShift.id, comment: null })
    for (const width of [390, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      await navigate(`/app/organizations/${org.id}/requests?tab=offers&location=${org.locationId}`, '.shift-offer-list--rows')
      await wait("document.querySelectorAll('.request-offer-row').length===2", 'Compact transfer and swap rows')
      assert(await evaluate("(()=>{const rows=[...document.querySelectorAll('.request-offer-row')];return rows[1].getBoundingClientRect().top>=rows[0].getBoundingClientRect().bottom-1&&rows.every(row=>row.scrollWidth<=row.clientWidth+1)})()"), 'Offer rows must be stacked and must not clip their contents')
      assert(await evaluate("document.querySelectorAll('.request-offer-row button button').length===0"), 'Independent profile controls must not nest buttons')
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
      await shot(`transfer-swap-rows-${width}`)
    }
    await evaluate("document.querySelector('.request-offer-row .staffly-action-surface__open').click()")
    await wait("!!document.querySelector('.shift-offer-card--detail')", 'Transfer detail opens from row')
    checks.push('transfer/swap use compact request rows on desktop/mobile and independent profile controls stay valid')
    const all = await prisma.organizationLocation.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } })
    await prisma.organizationLocation.updateMany({ where: { id: { in: all.slice(2).map(point => point.id) } }, data: { archivedAt: new Date() } })
    for (const width of [320, 390, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 })
      await navigate(`/app/organizations/${org.id}`, '.dashboard-scope-picker .location-switcher--inline')
      assert.equal(await evaluate("document.querySelectorAll('.dashboard-scope-picker .location-choice').length"), 3)
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
      await shot(`two-locations-${width}`)
    }
    checks.push('two-point chips and ten-point searchable menus fit desktop/mobile without a top banner')
    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await navigate('/', '.hero__preview')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.hero__preview-people')).animationName"), 'none')
    checks.push('reduced motion disables decorative animations')
    assert.equal(errors.length, 0, errors.join('\n'))
    return { passed: true, checks, screenshots, consoleErrors: errors }
  } catch (error) { await shot('subscription-ui-failure').catch(() => {}); throw error }
  finally { cdp.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`) }
}
