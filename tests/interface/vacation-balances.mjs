import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import sharp from 'sharp'
import AxeBuilder from '@axe-core/playwright'

export async function runVacationBalances({ prisma, env, root, temporary, output, options, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, firefox, webkit, expect } = await import('playwright/test')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const { createRequest, resolveRequest, listRequestTypes } = await import('../../src/server/requests/service.ts')
  const { storage } = await import('../../src/server/storage/provider.ts')
  const { vacationDays } = await import('../../src/shared/request-workflow.ts')
  const { addVacationDays, vacationMonthDate } = await import('../../src/shared/vacation-balance.ts')
  const socket = socketServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin
  env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi()
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-vacation'), plugins: [react(), devApiProxy(Number(new URL(api).port))], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  const result = { status: 'running', checks: [], screenshots: [], errors: [] }
  const save = () => writeFile(path.join(output, 'vacation-balances.json'), JSON.stringify(result, null, 2))
  const sizes = { desktop: [1440, 1050], tablet: [768, 1024], mobile: [390, 844], narrow: [320, 780] }
  const firefoxHome = path.join(temporary, 'firefox-home')
  await mkdir(firefoxHome, { recursive: true })
  const launch = {
    chrome: () => chromium.launch({ executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true }),
    firefox: () => firefox.launch({ headless: true, env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }),
    webkit: () => webkit.launch({ headless: true }),
  }
  async function signIn(browser, userId, theme, width, height) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'ru-RU', timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' })
    await context.addInitScript(value => { localStorage.setItem('staffly.theme', value); localStorage.setItem('staffly-cookie-consent', 'necessary') }, theme)
    const token = randomUUID() + randomUUID(), browserToken = randomBytes(48).toString('base64url')
    await prisma.authSession.create({ data: { userId, browserTokenHash: createHash('sha256').update(browserToken).digest('hex'), refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
    await context.addCookies(['staffly_refresh', 'staffly_browser'].map(name => ({ name, value: name === 'staffly_refresh' ? token : browserToken, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })))
    return context
  }
  try {
    for (const engine of (options.browsers ?? 'chrome').split(',')) {
      const browser = await launch[engine]()
      try {
        for (const theme of options.theme ? [options.theme] : ['light', 'dark']) {
          for (const viewport of (options.viewports ?? 'desktop,mobile,narrow').split(',')) {
            const [width, height] = sizes[viewport]
            const prefix = `${engine}-${theme}-${viewport}`
            const owner = await prisma.user.create({ data: { email: `leave-owner-${randomUUID()}@example.test`, passwordHash: 'synthetic-only', emailVerifiedAt: new Date(), firstName: 'Анна', lastName: 'Смирнова' } })
            const org = await createBusinessOrganization(owner.id, { name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow' })
            const point = org.locationId
            await prisma.organizationLocation.update({ where: { id: point }, data: { name: 'Центральная' } })
            const person = await prisma.user.create({ data: { email: `leave-person-${randomUUID()}@example.test`, passwordHash: 'synthetic-only', emailVerifiedAt: new Date(), firstName: 'Михаил', lastName: 'Соколов' } })
            const employee = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: person.id, workEmail: 'm.sokolov@example.test' } })
            await prisma.locationMember.create({ data: { organizationId: org.id, memberId: employee.id, locationId: point } })
            const position = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Бариста' } })
            await prisma.memberPosition.create({ data: { memberId: employee.id, positionId: position.id } })
            const avatar = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#c9dcd7"/><ellipse cx="48" cy="90" rx="34" ry="29" fill="#426958"/><circle cx="48" cy="39" r="23" fill="#e3baa1"/><path d="M25 37Q24 9 48 12Q74 9 71 39L65 24Q47 34 29 27Z" fill="#493a35"/><circle cx="40" cy="40" r="2" fill="#493a35"/><circle cx="56" cy="40" r="2" fill="#493a35"/></svg>')).webp().toBuffer()
            const objectKey = `users/${person.id}/avatars/${randomUUID()}.webp`
            await storage.put(objectKey, avatar)
            const file = await prisma.storedFile.create({ data: { uploadedByUserId: person.id, purpose: 'USER_AVATAR', objectKey, mimeType: 'image/webp', size: avatar.length, checksumSha256: createHash('sha256').update(avatar).digest('hex') } })
            await prisma.user.update({ where: { id: person.id }, data: { avatarFileId: file.id } })
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
            const paidEnd = (first, count) => {
              let end = first
              while (vacationDays(first, end) < count) end = addVacationDays(end, 1)
              return end
            }
            const future = addVacationDays(today, 7)
            const type = (await listRequestTypes(owner.id, org.id)).find(item => item.systemCode === 'VACATION')
            const approved = await createRequest(person.id, org.id, { requestTypeId: type.id, startDate: future, endDate: paidEnd(future, 7), comment: 'Согласованный отпуск' })
            await resolveRequest(owner.id, org.id, approved.id, 'APPROVED', null)
            const request = await createRequest(person.id, org.id, { requestTypeId: type.id, startDate: addVacationDays(today, 21), endDate: paidEnd(addVacationDays(today, 21), 14), comment: 'Планирую отпуск в декабре' })
            const context = await signIn(browser, owner.id, theme, width, height)
            const page = await context.newPage()
            page.on('pageerror', error => result.errors.push({ prefix, message: error.message }))
            const url = `${origin}/app/organizations/${org.id}/requests?tab=vacations&location=${point}`
            const fit = async () => {
              await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
              const dialog = page.getByRole('dialog').last()
              if (await dialog.isVisible()) {
                const bounds = await dialog.boundingBox()
                assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
                assert(bounds.y >= 0 && bounds.y + bounds.height <= height + 1)
              }
            }
            const shot = async name => {
              await fit()
              const notices = page.getByRole('button', { name: 'Закрыть уведомление', exact: true })
              await notices.evaluateAll(buttons => buttons.forEach(button => button.click()))
              const dialogHeading = page.getByRole('dialog').last().getByRole('heading').first()
              if (await dialogHeading.isVisible()) await dialogHeading.click()
              await page.mouse.move(0, 0)
              const filename = `${prefix}-${name}.png`
              await page.screenshot({ path: path.join(output, filename), fullPage: !await page.getByRole('dialog').count() })
              result.screenshots.push(filename)
            }
            const check = async (name, task) => {
              try { await task(); result.checks.push({ prefix, name }); await save() }
              catch (error) {
                result.status = 'failed'
                result.checks.push({ prefix, name, error: error.message })
                await page.screenshot({ path: path.join(output, `${prefix}-failure.png`), fullPage: true })
                await writeFile(path.join(output, `${prefix}-failure.txt`), await page.locator('body').innerText())
                await save()
                throw error
              }
            }
            const pick = async (dialog, label, date) => {
              await dialog.getByRole('button', { name: new RegExp(`^${label}(?::|,|$)`) }).click()
              const calendar = page.getByRole('dialog', { name: 'Выбор даты', exact: true })
              let iterations = 0
              while (!await calendar.locator(`[data-date="${date}"]`).count()) {
                assert(iterations++ < 36, 'Date must be reachable without an unbounded navigation loop')
                const wanted = date.slice(0, 7)
                const first = await calendar.locator('[data-date]').first().getAttribute('data-date')
                await calendar.getByRole('button', { name: wanted < first.slice(0, 7) ? 'Предыдущий месяц' : 'Следующий месяц', exact: true }).click()
                await expect.poll(() => calendar.locator('[data-date]').first().getAttribute('data-date')).not.toBe(first)
              }
              await calendar.locator(`[data-date="${date}"]`).click()
            }
            try {
              await page.goto(url)
              await page.getByRole('button', { name: 'Остатки сотрудников', exact: true }).click()
              let dialog = page.getByRole('dialog', { name: 'Остатки отпусков', exact: true })
              await check('search, unconfigured state and real employee avatar', async () => {
                await dialog.getByRole('searchbox', { name: 'Поиск сотрудника' }).fill('Соколов')
                await expect(dialog.locator('tbody tr')).toHaveCount(1)
                await expect(dialog.locator('tbody')).toContainText('Не настроен')
                await expect.poll(() => dialog.locator('tbody img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
                await shot('manager-unconfigured')
              })
              await dialog.getByRole('button', { name: 'Начать учёт: Соколов Михаил', exact: true }).click()
              dialog = page.getByRole('dialog', { name: 'Начать учёт отпуска', exact: true })
              await check('annual norm defaults automatically and previous balance import is optional', async () => {
                await expect(dialog.getByRole('spinbutton', { name: 'Норма, дней в год' })).toHaveValue('28')
                await pick(dialog, 'Дата приёма на работу', vacationMonthDate(today, -12))
                await expect(dialog).toContainText('28 дн.')
                await shot('automatic-start')
                await dialog.getByRole('checkbox', { name: 'Перенести остаток из прежнего учёта' }).check()
                await dialog.getByRole('spinbutton', { name: 'Сколько дней осталось' }).fill('18')
                await dialog.getByRole('textbox', { name: 'Основание переноса' }).fill('По данным бухгалтерии на дату начала учёта')
                await shot('previous-balance-import')
                await dialog.getByRole('button', { name: 'Начать учёт', exact: true }).click()
                dialog = page.getByRole('dialog', { name: 'Остатки отпусков', exact: true })
                await expect(dialog.locator('tbody tr').filter({ hasText: 'Соколов' })).toContainText('18')
                await shot('manager-balances')
              })
              await check('correction previews its result and saves with a reason', async () => {
                await dialog.getByRole('button', { name: 'Изменить: Соколов Михаил', exact: true }).click()
                dialog = page.getByRole('dialog', { name: 'Изменить остаток отпуска', exact: true })
                await dialog.getByRole('spinbutton', { name: 'Количество дней', exact: true }).fill('2')
                await dialog.getByRole('textbox', { name: 'Причина изменения', exact: true }).fill('Дополнительные дни по условиям договора')
                await expect(dialog.locator('.vacation-balance-result')).toContainText('20')
                await shot('correction')
                await dialog.getByRole('button', { name: 'Сохранить изменение', exact: true }).click()
                dialog = page.getByRole('dialog', { name: 'Остатки отпусков', exact: true })
                await dialog.getByRole('button', { name: 'История: Соколов Михаил', exact: true }).click()
                dialog = page.getByRole('dialog', { name: 'История остатка отпуска', exact: true })
                await expect(dialog).toContainText('Дополнительные дни по условиям договора')
                await expect(dialog).toContainText('18 → 20')
                await shot('history')
                if (viewport === 'desktop') {
                  const axe = await new AxeBuilder({ page }).include('.vacation-balances-dialog').analyze()
                  assert.deepEqual(axe.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => item.id), [])
                }
                await dialog.getByRole('button', { name: 'Закрыть', exact: true }).last().click()
              })
              await check('review shows an advance warning without an extra confirmation', async () => {
                await page.goto(`${url}&request=${request.id}`)
                const preview = page.getByRole('region', { name: 'Расчёт остатка отпуска' })
                await expect(preview).toContainText('Запрос превышает')
                await page.getByRole('button', { name: 'Рассмотреть заявку', exact: true }).click()
                const review = page.getByRole('dialog', { name: 'Рассмотреть заявку', exact: true })
                await expect(review.getByRole('radio', { name: 'Одобрить', exact: true })).toBeChecked()
                await expect(review.getByRole('button', { name: 'Сохранить решение', exact: true })).toBeEnabled()
                await expect(review.getByRole('checkbox')).toHaveCount(0)
                await shot('approval-warning')
              })
              await check('employee sees own balance and request impact without manager controls', async () => {
                await prisma.accountNotification.updateMany({ where: { organizationId: org.id, userId: person.id }, data: { readAt: new Date() } })
                const employeeContext = await signIn(browser, person.id, theme, width, height)
                const employeePage = await employeeContext.newPage()
                try {
                  await employeePage.goto(url)
                  await expect(employeePage.getByRole('region', { name: 'Ваш остаток отпуска' })).toContainText('20')
                  await expect(employeePage.getByRole('button', { name: 'Остатки сотрудников', exact: true })).toHaveCount(0)
                  await employeePage.screenshot({ path: path.join(output, `${prefix}-employee-page.png`), fullPage: true })
                  result.screenshots.push(`${prefix}-employee-page.png`)
                  const balanceEndpoint = url => url.pathname === `/api/organizations/${org.id}/vacation-balance`
                  await employeePage.route(balanceEndpoint, route => route.fulfill({
                    status: 403, contentType: 'application/json',
                    body: JSON.stringify({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Недостаточно прав для этого действия.' }),
                  }))
                  const refusedRead = employeePage.waitForResponse(response => new URL(response.url()).pathname === `/api/organizations/${org.id}/vacation-balance` && response.status() === 403)
                  await employeePage.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
                  await refusedRead
                  await expect(employeePage.getByRole('region', { name: 'Ваш остаток отпуска' })).toHaveCount(0)
                  await expect(employeePage.getByRole('alert')).toContainText('Недостаточно прав')
                  await expect(employeePage.getByText('Код для поддержки', { exact: true })).toHaveCount(0)
                  await employeePage.unroute(balanceEndpoint)
                  await employeePage.getByRole('button', { name: 'Повторить', exact: true }).click()
                  await expect(employeePage.getByRole('region', { name: 'Ваш остаток отпуска' })).toContainText('20')
                  await employeePage.getByRole('button', { name: 'Предложить отпуск', exact: true }).click()
                  const form = employeePage.getByRole('dialog', { name: 'Создать заявку', exact: true })
                  const first = addVacationDays(today, 21), last = addVacationDays(first, 6)
                  const choose = async (label, date) => {
                    await form.getByRole('button', { name: new RegExp(`^${label}(?::|,|$)`) }).click()
                    const calendar = employeePage.getByRole('dialog', { name: 'Выбор даты', exact: true })
                    let moves = 0
                    while (!await calendar.locator(`[data-date="${date}"]`).count()) {
                      assert(moves++ < 4, 'Selected request dates must be within four calendar months')
                      const firstDay = await calendar.locator('[data-date]').first().getAttribute('data-date')
                      await calendar.getByRole('button', { name: date < firstDay ? 'Предыдущий месяц' : 'Следующий месяц', exact: true }).click()
                      await expect.poll(() => calendar.locator('[data-date]').first().getAttribute('data-date')).not.toBe(firstDay)
                    }
                    await calendar.locator(`[data-date="${date}"]`).click()
                  }
                  await choose('Первый день', first)
                  await choose('Последний день', last)
                  await expect(form.getByRole('region', { name: 'Расчёт остатка отпуска' })).toContainText('После согласования')
                  await employeePage.screenshot({ path: path.join(output, `${prefix}-new-request.png`), fullPage: false })
                  result.screenshots.push(`${prefix}-new-request.png`)
                } catch (error) {
                  await employeePage.screenshot({ path: path.join(output, `${prefix}-employee-failure.png`) })
                  await writeFile(path.join(output, `${prefix}-employee-failure.txt`), await employeePage.locator('body').innerText())
                  throw error
                } finally { await employeeContext.close() }
              })
              await check('manager explicitly classifies leave service and records the reason', async () => {
                const absence = await prisma.employeeAbsence.create({ data: {
                  organizationId: org.id, memberId: employee.id, type: 'SICK', reason: 'PERSONAL',
                  startDate: new Date(addVacationDays(today, -3)), endDate: new Date(addVacationDays(today, -1)),
                } })
                await page.goto(`${origin}/app/organizations/${org.id}/schedule?location=${point}&absences=1&absence=${absence.id}`)
                const panel = page.getByRole('dialog').last()
                await panel.getByRole('button', { name: 'Изменить период', exact: true }).click()
                await panel.getByRole('combobox', { name: 'Учёт в отпускном стаже', exact: true }).click()
                await page.getByRole('option', { name: 'Не входит в отпускной стаж', exact: true }).click()
                await panel.getByRole('textbox', { name: 'Причина изменения', exact: true }).fill('Уточнение периода отпускного стажа')
                await shot('absence-service')
                await panel.getByRole('button', { name: 'Сохранить период', exact: true }).click()
                await expect.poll(async () => (await prisma.employeeAbsence.findUniqueOrThrow({ where: { id: absence.id } })).vacationService).toBe('EXCLUDED')
                const history = await prisma.accessAudit.findMany({ where: { organizationId: org.id, action: 'VACATION_SERVICE_CHANGED' } })
                assert.ok(history.some(entry => entry.details.absenceId === absence.id))
              })
              await check('lower tariff keeps vacations open without balance requests or recurring upgrade popups', async () => {
                // First exercise a live downgrade. Old in-flight/focus reads may
                // be refused by the server; the UI must hide paid data silently.
                await page.goto(url)
                await expect(page.getByRole('region', { name: 'Ваш остаток отпуска' })).toBeVisible()
                await prisma.organizationSubscription.update({ where: { organizationId: org.id }, data: { plan: 'FREE', periodEnd: null, trialEndsAt: null } })
                await page.evaluate(() => window.dispatchEvent(new Event('focus')))
                await expect(page.getByRole('button', { name: /Остатки сотрудников/ })).toContainText('Бизнес')
                await expect(page.getByRole('region', { name: 'Ваш остаток отпуска' })).toHaveCount(0)
                await expect(page.getByRole('dialog')).toHaveCount(0)
                // Then verify a fresh navigation on an already unavailable plan.
                const balanceCalls = []
                page.on('request', request => { if (new URL(request.url()).pathname.startsWith(`/api/organizations/${org.id}/vacation-balance`)) balanceCalls.push(request.url()) })
                await page.goto(url)
                await expect(page.getByRole('button', { name: /Остатки сотрудников/ })).toContainText('Бизнес')
                await expect(page.locator('.vacation-calendar')).toBeVisible()
                await page.evaluate(() => window.dispatchEvent(new Event('focus')))
                await expect(page.getByRole('dialog')).toHaveCount(0)
                await expect(page.getByText('Код для поддержки', { exact: true })).toHaveCount(0)
                assert.deepEqual(balanceCalls, [])
              })
            } finally { await context.close() }
          }
        }
      } finally { await browser.close() }
    }
  } finally {
    await server.close()
    if (process.platform === 'darwin') await new Promise(resolve => {
      const child = spawn('/bin/chmod', ['-R', '-P', '-N', firefoxHome], { stdio: 'ignore' })
      child.once('error', resolve)
      child.once('exit', resolve)
    })
  }
  assert.deepEqual(result.errors, [])
  result.status = 'passed'
  await save()
  return result
}
