import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import AxeBuilder from '@axe-core/playwright'
import sharp from 'sharp'

export async function runShiftBatch({ prisma, env, root, temporary, output, options, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true')
  assert(path.resolve(env.LOCAL_STORAGE_ROOT).startsWith(path.resolve(temporary) + path.sep))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, firefox, webkit, expect } = await import('playwright/test')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const { storage } = await import('../../src/server/storage/provider.ts')
  const socket = socketServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin
  env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi()
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-cache'), plugins: [react(), devApiProxy(Number(new URL(api).port))], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  const firefoxHome = path.join(temporary, 'firefox-home')
  await mkdir(firefoxHome, { recursive: true })
  const launch = {
    chrome: () => chromium.launch({
      executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
      headless: options.headed !== 'true',
      // Native scrollbar visuals are part of this acceptance scenario.
      ignoreDefaultArgs: ['--hide-scrollbars'],
    }),
    // Firefox's headless Juggler injects an AGENT_SHEET hiding all scrollbars.
    // Use --headed=true when checking native Firefox scrollbar geometry.
    firefox: () => firefox.launch({ headless: options.headed !== 'true', env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }),
    webkit: () => webkit.launch({ headless: options.headed !== 'true' }),
  }
  const sizes = { desktop: [1440, 1050], tablet: [768, 1024], mobile: [390, 844], narrow: [320, 780], short: [1440, 560] }
  const result = { status: 'running', checks: [], screenshots: [], errors: [] }
  const save = () => writeFile(path.join(output, 'shift-batch.json'), JSON.stringify(result, null, 2))

  try {
    for (const engine of (options.browsers ?? 'chrome').split(',')) {
      const browser = await launch[engine]()
      try {
        for (const theme of options.theme ? [options.theme] : ['light', 'dark']) {
          for (const viewport of (options.viewports ?? 'desktop,tablet,mobile,narrow,short').split(',')) {
            const [width, height] = sizes[viewport]
            const owner = await prisma.user.create({ data: { email: `shift-owner-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Анна', lastName: 'Смирнова' } })
            const org = await createBusinessOrganization(owner.id, { name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'Центральная', timezone: 'Europe/Moscow', city: 'Москва', address: 'Лесная, 8' } })
            const point = org.locations[0]
            const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
            const user = await prisma.user.create({ data: { email: `shift-person-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Михаил', lastName: 'Соколов' } })
            const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })
            await prisma.locationMember.create({ data: { organizationId: org.id, locationId: point.id, memberId: member.id } })
            const portrait = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#c9dcd7"/><ellipse cx="48" cy="90" rx="34" ry="29" fill="#426958"/><circle cx="48" cy="39" r="23" fill="#e3baa1"/><path d="M25 37Q24 9 48 12Q74 9 71 39L65 24Q47 34 29 27Z" fill="#493a35"/><circle cx="40" cy="40" r="2" fill="#493a35"/><circle cx="56" cy="40" r="2" fill="#493a35"/></svg>')).webp().toBuffer()
            const objectKey = `users/${user.id}/avatars/${randomUUID()}.webp`
            await storage.put(objectKey, portrait)
            const avatar = await prisma.storedFile.create({ data: { uploadedByUserId: user.id, purpose: 'USER_AVATAR', objectKey, mimeType: 'image/webp', size: portrait.length, checksumSha256: createHash('sha256').update(portrait).digest('hex') } })
            await prisma.user.update({ where: { id: user.id }, data: { avatarFileId: avatar.id } })
            const position = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Бариста' } })
            await prisma.memberPosition.create({ data: { memberId: member.id, positionId: position.id } })
            await prisma.shiftTemplate.create({ data: { organizationId: org.id, locationId: point.id, positionId: position.id, name: 'Дневная', startTime: '09:00', endTime: '18:00' } })
            const context = await browser.newContext({ viewport: { width, height }, locale: 'ru-RU', timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' })
            const prefix = `${engine}-${theme}-${viewport}`
            const page = await context.newPage()
            page.on('pageerror', error => result.errors.push({ prefix, message: error.message }))
            const check = async (name, task) => {
              try { await task(); result.checks.push({ engine, theme, viewport, name }); await save(); console.log(`${prefix}: ${name}`) }
              catch (error) {
                result.status = 'failed'
                result.checks.push({ engine, theme, viewport, name, error: error.message })
                await save()
                await page.screenshot({ path: path.join(output, `${prefix}-failure.png`) })
                await writeFile(path.join(output, `${prefix}-failure.txt`), await page.locator('body').innerText())
                throw error
              }
            }
            const shot = async (name, pageView = false) => {
              if (name !== 'employee-search') {
                const title = page.getByRole('heading', { name: 'Создать смены', exact: true })
                if (await title.isVisible()) await title.click()
                await page.mouse.move(0, 0)
              }
              const file = `${prefix}-${name}.png`
              await page.screenshot({ path: path.join(output, file), fullPage: pageView })
              result.screenshots.push(file)
            }
            try {
              await context.addInitScript(value => { localStorage.setItem('staffly.theme', value); localStorage.setItem('staffly-cookie-consent', 'necessary') }, theme)
              const token = randomUUID() + randomUUID(), browserToken = randomBytes(48).toString('base64url')
              await prisma.authSession.create({ data: { userId: owner.id, browserTokenHash: createHash('sha256').update(browserToken).digest('hex'), refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
              await context.addCookies(['staffly_refresh', 'staffly_browser'].map(name => ({ name, value: name === 'staffly_refresh' ? token : browserToken, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' })))
              await page.goto(`${origin}/app/organizations/${org.id}/schedule?location=${point.id}&month=2030-11`)
              await page.getByRole('button', { name: /Добавить смену/ }).first().click()
              let dialog = page.getByRole('dialog', { name: 'Создать смену', exact: true })
              await check('existing employee search filters names and shows the actual avatar', async () => {
                await dialog.getByRole('checkbox', { name: 'Добавить смены на несколько дат', exact: true }).check()
                dialog = page.getByRole('dialog', { name: 'Создать смены', exact: true })
                await dialog.getByRole('combobox', { name: 'Сотрудник', exact: true }).click()
                await page.getByRole('combobox', { name: 'Поиск сотрудника', exact: true }).fill('Соколов')
                await expect(page.getByRole('option')).toHaveCount(1)
                await expect.poll(() => page.getByRole('option').locator('img').evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true)
                await shot('employee-search')
                await page.getByRole('option').click()
                await expect(dialog.getByRole('combobox', { name: 'Сотрудник', exact: true })).toContainText('Соколов Михаил')
              })
              const period = dialog.locator('.batch-editor__period')
              const pick = async (label, day) => {
                await period.getByRole('button', { name: new RegExp(`^${label},`) }).click()
                await page.getByRole('dialog', { name: 'Выбор даты', exact: true }).locator(`[data-date="${day}"]`).click()
              }
              const selectRange = async () => {
                await dialog.getByRole('button', { name: 'Диапазон', exact: true }).click()
                await pick('С', '2030-11-16')
                await pick('По', '2030-11-30')
                await dialog.getByRole('button', { name: 'Выбрать диапазон', exact: true }).click()
                await expect(dialog.locator('.batch-shift')).toHaveCount(15)
              }
              await check('range and weekdays select exact dates without silently truncating selection', async () => {
                await selectRange()
                if (viewport === 'desktop') {
                  await dialog.locator('.shift-form__body').evaluate(node => { node.scrollTop = 0 })
                  await shot('date-range')
                }
                await dialog.getByRole('button', { name: 'Дни недели', exact: true }).click()
                await dialog.getByRole('group', { name: 'Дни недели смен', exact: true }).getByRole('button', { name: 'Вт', exact: true }).click()
                await dialog.getByRole('group', { name: 'Дни недели смен', exact: true }).getByRole('button', { name: 'Чт', exact: true }).click()
                await dialog.getByRole('button', { name: 'Выбрать дни недели', exact: true }).click()
                await expect(dialog.locator('.batch-shift')).toHaveCount(6)
                const names = await dialog.locator('.batch-shift').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
                assert.deepEqual(names, ['18 ноября 2030 г.', '20 ноября 2030 г.', '22 ноября 2030 г.', '25 ноября 2030 г.', '27 ноября 2030 г.', '29 ноября 2030 г.'])
                if (viewport === 'desktop') {
                  await dialog.locator('.shift-form__body').evaluate(node => { node.scrollTop = 0 })
                  await shot('weekdays')
                }
                await selectRange()
                await pick('С', '2030-11-30')
                await pick('По', '2030-11-16')
                await dialog.getByRole('button', { name: 'Выбрать диапазон', exact: true }).click()
                await expect(dialog.getByRole('alert')).toContainText('Конец периода')
                await expect(dialog.locator('.batch-shift')).toHaveCount(15)
                await selectRange()
                await dialog.getByRole('button', { name: 'Вручную', exact: true }).click()
              })
              const common = dialog.getByRole('region', { name: 'Общее время смен', exact: true })
              const row = dialog.getByRole('article', { name: '18 ноября 2030 г.', exact: true })
              await check('common time preserves individual changes, reset restores inheritance and night shifts cross dates', async () => {
                await row.getByRole('button', { name: /^Изменить смену/ }).click()
                await row.getByRole('textbox', { name: 'Начало', exact: true }).fill('10:00')
                await row.getByRole('textbox', { name: 'Окончание', exact: true }).fill('19:00')
                await common.getByRole('textbox', { name: 'Начало', exact: true }).fill('08:00')
                await expect(row.getByRole('textbox', { name: 'Начало', exact: true })).toHaveValue('10:00')
                await dialog.getByRole('combobox', { name: 'Шаблон времени', exact: true }).click()
                await page.getByRole('option', { name: /Дневная/ }).click()
                await expect(row.getByRole('textbox', { name: 'Начало', exact: true })).toHaveValue('10:00')
                await row.getByRole('button', { name: 'Вернуть общее время', exact: true }).click()
                await expect(row.getByRole('textbox', { name: 'Начало', exact: true })).toHaveValue('09:00')
                await expect(row.locator('.batch-shift__badge')).toHaveCount(0)
                await row.getByRole('textbox', { name: 'Начало', exact: true }).fill('22:00')
                await row.getByRole('textbox', { name: 'Окончание', exact: true }).fill('06:00')
                await row.getByRole('checkbox', { name: 'На следующий день', exact: true }).check()
                await common.getByRole('textbox', { name: 'Начало', exact: true }).fill('09:00')
                await expect(row.getByRole('textbox', { name: 'Начало', exact: true })).toHaveValue('22:00')
                await row.scrollIntoViewIfNeeded()
                await shot('individual-time')
                await row.getByRole('button', { name: /^Свернуть смену/ }).click()
                await dialog.locator('.shift-form__body').evaluate(node => { node.scrollTop = 0 })
                await shot('batch-form')
              })
              await check('one scroll region, pinned actions, styles and accessibility fit the viewport', async () => {
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
                const box = await dialog.boundingBox()
                assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, JSON.stringify(box))
                const footer = dialog.locator('form > footer')
                const before = await footer.boundingBox()
                await dialog.locator('.shift-form__body').evaluate(node => { node.scrollTop = node.scrollHeight })
                const after = await footer.boundingBox()
                assert(Math.abs(before.y - after.y) < 1)
                await expect(dialog.getByRole('button', { name: 'Создать 15 смен', exact: true })).toBeInViewport()
                const scrolls = await dialog.evaluate(root => [...root.querySelectorAll('div,section,article,form,fieldset')].filter(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1).map(node => node.className))
                assert.deepEqual(scrolls, ['shift-form__body'])
                assert.equal(await row.locator('.batch-editor__button').first().evaluate(node => getComputedStyle(node).textDecorationLine), 'none')
                const scrollbar = await dialog.locator('.shift-form__body').evaluate(node => ({
                  webkit: CSS.supports('selector(::-webkit-scrollbar)'),
                  width: getComputedStyle(node).scrollbarWidth,
                  pseudo: getComputedStyle(node, '::-webkit-scrollbar').width,
                  display: getComputedStyle(node, '::-webkit-scrollbar').display,
                  forcedColors: matchMedia('(forced-colors: active)').matches,
                }))
                assert.equal(engine === 'firefox' ? scrollbar.width : scrollbar.pseudo, engine === 'firefox' ? 'thin' : '8px', JSON.stringify(scrollbar))
                if (engine !== 'firefox') assert.notEqual(scrollbar.display, 'none', 'The scrollbar must be displayed')
                const axe = await new AxeBuilder({ page }).include('.schedule-shift-dialog').withTags(['wcag2a', 'wcag2aa']).analyze()
                assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => node.target) })), [])
              })
              await check('a failed request preserves the full batch and its exception', async () => {
                const route = url => new URL(url).pathname.endsWith('/shifts/batch')
                await page.route(route, async intercepted => intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Сервис временно недоступен. Повторите сохранение.' }) }))
                await dialog.getByRole('button', { name: 'Создать 15 смен', exact: true }).click()
                await expect(dialog.getByRole('alert')).toContainText('Сервис временно недоступен')
                await expect(dialog.locator('.batch-shift')).toHaveCount(15)
                await expect(row).toContainText('22:00–06:00')
                await page.unroute(route)
                assert.equal(await prisma.workShift.count({ where: { organizationId: org.id } }), 0)
              })
              await check('changing calendar dates invalidates a previous workload confirmation', async () => {
                const route = url => new URL(url).pathname.endsWith('/shifts/batch')
                await page.route(route, async intercepted => intercepted.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'WORKLOAD_WARNING', message: 'Превышена месячная норма.' }) }))
                await dialog.getByRole('button', { name: 'Создать 15 смен', exact: true }).click()
                const confirmation = dialog.getByRole('checkbox', { name: 'Подтверждаю сохранение с превышением месячной нормы', exact: true })
                await expect(confirmation).toBeVisible()
                await confirmation.check()
                await expect(dialog.getByRole('button', { name: 'Создать 15 смен', exact: true })).toBeEnabled()
                const lastDate = dialog.getByRole('region', { name: 'Даты новых смен', exact: true }).getByRole('button', { name: '30 ноября 2030 г.', exact: true })
                await lastDate.click()
                await expect(confirmation).toHaveCount(0)
                await expect(dialog.getByRole('button', { name: 'Создать 14 смен', exact: true })).toBeEnabled()
                await lastDate.click()
                await expect(dialog.locator('.batch-shift')).toHaveCount(15)
                await page.unroute(route)
              })
              await check('one real conflict rolls back the whole batch, and retry saves all 15 correct intervals', async () => {
                const conflict = await prisma.workShift.create({ data: { organizationId: org.id, locationId: point.id, memberId: member.id, createdByMemberId: ownerMember.id, scheduledStartAt: new Date('2030-11-25T07:00:00Z'), scheduledEndAt: new Date('2030-11-25T12:00:00Z') } })
                await dialog.getByRole('button', { name: 'Создать 15 смен', exact: true }).click()
                await expect(dialog.getByRole('alert')).toContainText('Уже назначена смена')
                await expect(dialog.getByRole('article', { name: '25 ноября 2030 г.', exact: true })).toHaveClass(/has-error/)
                assert.equal(await prisma.workShift.count({ where: { organizationId: org.id } }), 1)
                await expect(dialog.locator('.batch-shift')).toHaveCount(15)
                await prisma.workShift.delete({ where: { id: conflict.id } })
                await dialog.getByRole('textbox', { name: 'Комментарий ко всем сменам', exact: true }).fill('Массовое назначение для приёмки')
                await dialog.getByRole('button', { name: 'Создать 15 смен', exact: true }).click()
                await expect(dialog).toBeHidden()
                const saved = await prisma.workShift.findMany({ where: { organizationId: org.id }, orderBy: { scheduledStartAt: 'asc' } })
                assert.equal(saved.length, 15)
                for (const shift of saved) {
                  assert.equal(shift.memberId, member.id)
                  assert.equal(shift.positionId, position.id)
                  assert.equal(shift.description, 'Массовое назначение для приёмки')
                  const day = shift.scheduledStartAt.toISOString().slice(0, 10)
                  assert.equal(shift.scheduledStartAt.toISOString().slice(11), day === '2030-11-18' ? '19:00:00.000Z' : '06:00:00.000Z')
                  assert.equal(shift.scheduledEndAt.toISOString(), day === '2030-11-18' ? '2030-11-19T03:00:00.000Z' : `${day}T15:00:00.000Z`)
                }
                await page.getByRole('button', { name: /^16 ноября 2030 г., смен: 1/ }).press('Enter')
                await expect(page.getByRole('complementary', { name: 'Смены выбранного дня', exact: true })).toContainText('Соколов Михаил')
                await page.reload()
                await page.getByRole('button', { name: /^16 ноября 2030 г., смен: 1/ }).press('Enter')
                await expect(page.getByRole('complementary', { name: 'Смены выбранного дня', exact: true })).toContainText('Соколов Михаил')
                await shot('schedule-page', true)
              })
            } finally { await context.close() }
          }
        }
      } finally { await browser.close() }
    }
  } finally {
    await server.close()
    // macOS adds deny-delete ACLs to Library/Downloads in the isolated Firefox home.
    // Match the other browser suites: remove only this disposable home's ACLs.
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
