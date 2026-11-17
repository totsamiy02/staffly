import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import AxeBuilder from '@axe-core/playwright'
import sharp from 'sharp'

export async function runAvailability({ prisma, env, root, temporary, output, options, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, expect } = await import('playwright/test')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const { storage } = await import('../../src/server/storage/provider.ts')
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const socket = socketServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin
  env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi()
  const server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(temporary, 'vite-availability'),
    plugins: [react(), devApiProxy(Number(new URL(api).port))],
    server: {
      host: '127.0.0.1', port, strictPort: true,
      watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] },
    },
    logLevel: 'error',
  })
  await server.listen()
  const browser = await chromium.launch({
    executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    headless: true,
  })
  const result = { status: 'running', checks: [], screenshots: [], errors: [] }
  const save = () => writeFile(path.join(output, 'availability.json'), JSON.stringify(result, null, 2))
  const sizes = { desktop: [1440, 1050], mobile: [390, 844], narrow: [320, 780] }

  async function session(userId, theme, viewport) {
    const [width, height] = sizes[viewport]
    const context = await browser.newContext({ viewport: { width, height }, locale: 'ru-RU', reducedMotion: 'reduce' })
    await context.addInitScript(value => {
      localStorage.setItem('staffly.theme', value)
      localStorage.setItem('staffly-cookie-consent', 'necessary')
    }, theme)
    const token = randomUUID() + randomUUID()
    const browserToken = randomBytes(48).toString('base64url')
    await prisma.authSession.create({ data: {
      userId,
      browserTokenHash: createHash('sha256').update(browserToken).digest('hex'),
      refreshTokenHash: createHash('sha256').update(token).digest('hex'),
      idleExpiresAt: new Date(Date.now() + 3600000),
      absoluteExpiresAt: new Date(Date.now() + 3600000),
    } })
    await context.addCookies(['staffly_refresh', 'staffly_browser'].map(name => ({
      name, value: name === 'staffly_refresh' ? token : browserToken,
      domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax',
    })))
    return context
  }

  try {
    for (const theme of options.theme ? [options.theme] : ['light', 'dark']) {
      for (const viewport of (options.viewports ?? 'desktop,mobile,narrow').split(',')) {
        const prefix = `${theme}-${viewport}`
        const people = []
        for (const [firstName, lastName] of [['Анна', 'Смирнова'], ['Михаил', 'Соколов'], ['Мария', 'Орлова']]) {
          people.push(await prisma.user.create({ data: {
            email: `availability-${randomUUID()}@example.test`, passwordHash: 'synthetic-only',
            emailVerifiedAt: new Date(), firstName, lastName,
          } }))
        }
        for (const person of people) {
          const avatar = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
            <rect width="96" height="96" fill="#c9dcd7"/>
            <ellipse cx="48" cy="90" rx="34" ry="29" fill="#426958"/>
            <circle cx="48" cy="39" r="23" fill="#e3baa1"/>
            <path d="M25 37Q24 9 48 12Q74 9 71 39L65 24Q47 34 29 27Z" fill="#493a35"/>
            <circle cx="40" cy="40" r="2" fill="#493a35"/>
            <circle cx="56" cy="40" r="2" fill="#493a35"/>
          </svg>`)).webp().toBuffer()
          const objectKey = `users/${person.id}/avatars/${randomUUID()}.webp`
          await storage.put(objectKey, avatar)
          const file = await prisma.storedFile.create({ data: {
            uploadedByUserId: person.id, purpose: 'USER_AVATAR', objectKey,
            mimeType: 'image/webp', size: avatar.length, checksumSha256: createHash('sha256').update(avatar).digest('hex'),
          } })
          await prisma.user.update({ where: { id: person.id }, data: { avatarFileId: file.id } })
        }
        const org = await createBusinessOrganization(people[0].id, {
          name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow',
        })
        await prisma.organizationLocation.update({ where: { id: org.locationId }, data: { name: 'Центральная' } })
        const owner = await prisma.organizationMember.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId: org.id, userId: people[0].id } },
        })
        const members = []
        for (const person of people.slice(1)) {
          const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: person.id } })
          members.push(member)
          await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id } })
        }
        const startDay = new Date(Date.now() + 7 * 86400000)
        while (startDay.getUTCDay() !== 1) startDay.setUTCDate(startDay.getUTCDate() + 1)
        const monday = startDay.toISOString().slice(0, 10)
        const nextDay = days => new Date(+startDay + days * 86400000).toISOString().slice(0, 10)
        const tuesday = nextDay(1)
        const shift = await prisma.workShift.create({ data: {
          organizationId: org.id, locationId: org.locationId, memberId: members[0].id,
          createdByMemberId: owner.id, scheduledStartAt: new Date(`${tuesday}T07:00:00Z`), scheduledEndAt: new Date(`${tuesday}T15:00:00Z`),
        } })
        await prisma.workShift.create({ data: {
          organizationId: org.id, locationId: org.locationId, memberId: owner.id,
          createdByMemberId: owner.id, scheduledStartAt: shift.scheduledStartAt, scheduledEndAt: shift.scheduledEndAt,
        } })
        const context = await session(people[0].id, theme, viewport)
        const employeeContext = await session(people[1].id, theme, viewport)
        const page = await context.newPage()
        const employee = await employeeContext.newPage()
        for (const target of [page, employee]) {
          target.on('pageerror', error => result.errors.push({ prefix, error: error.message }))
          target.on('console', message => {
            if (message.type() === 'error' && /Application render failed|AuthProvider is missing/.test(message.text())) result.errors.push({ prefix, error: message.text() })
          })
        }
        const home = `${origin}/app/organizations/${org.id}`
        const schedule = `${home}/schedule?location=${org.locationId}`
        const availabilityUrl = `${schedule}&availability=${members[0].id}`
        const dialog = () => page.getByRole('dialog', { name: 'Доступность сотрудников', exact: true })
        const fit = async target => {
          await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
          const box = target.getByRole('dialog').last()
          if (await box.isVisible()) {
            const bounds = await box.boundingBox()
            const { width, height } = target.viewportSize()
            assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
            assert(bounds.y >= 0 && bounds.y + bounds.height <= height + 1)
          }
        }
        const shot = async (target, name) => {
          await fit(target)
          await target.mouse.move(0, 0)
          const filename = `${prefix}-${name}.png`
          await target.screenshot({ path: path.join(output, filename), fullPage: !await target.getByRole('dialog').count() })
          result.screenshots.push(filename)
        }
        const check = async (name, work) => {
          await work()
          result.checks.push({ prefix, name })
          await save()
        }
        const select = async (label, text, scope = dialog()) => {
          await scope.getByRole('combobox', { name: label, exact: true }).click()
          await page.getByRole('option', { name: text, exact: true }).click()
        }
        const date = async (scope, label, value, target = page) => {
          await scope.getByRole('button', { name: new RegExp(`^${label}(?:,|:)`) }).click()
          const calendar = target.getByRole('dialog', { name: 'Выбор даты', exact: true })
          await expect(calendar).toBeVisible()
          for (let month = 0; month < 24; month++) {
            if (await calendar.locator(`[data-date="${value}"]`).count()) break
            const header = await calendar.locator('header strong').innerText()
            await calendar.getByRole('button', { name: 'Следующий месяц', exact: true }).click()
            await expect(calendar.locator('header strong')).not.toHaveText(header)
          }
          await calendar.locator(`[data-date="${value}"]`).click()
        }
        try {
          await page.goto(schedule)
          await check('native calendar entry and searchable employee picker retain avatars', async () => {
            await page.getByLabel('Ещё: настройки календаря', { exact: true }).click()
            await shot(page, 'calendar-menu')
            await page.getByRole('button', { name: 'Доступность сотрудников Ограничения по дням и времени' }).click()
            await expect(dialog().getByRole('combobox', { name: 'Сотрудник', exact: true })).toBeVisible()
            await dialog().getByRole('combobox', { name: 'Сотрудник', exact: true }).click()
            await page.getByRole('combobox', { name: 'Поиск сотрудника', exact: true }).fill('Соколов')
            const option = page.getByRole('option').filter({ hasText: 'Соколов Михаил' })
            await expect(option).toBeVisible()
            await expect.poll(() => option.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
            await shot(page, 'employee-search')
            await option.click()
          })
          await check('effective weekly rules persist and leave existing shifts intact', async () => {
            await date(dialog(), 'Правила действуют с', monday)
            await select('Понедельник: доступность', 'Указать время')
            await dialog().getByLabel('Понедельник: с', { exact: true }).fill('16:00')
            await dialog().getByLabel('Понедельник: до', { exact: true }).fill('23:00')
            await select('Вторник: доступность', 'Недоступен')
            await shot(page, 'weekly-rules')
            await dialog().getByRole('button', { name: 'Сохранить доступность', exact: true }).click()
            await expect(dialog().getByRole('button', { name: 'Смены · 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
            assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).status, 'SCHEDULED')
            await shot(page, 'future-conflicts')
          })
          await check('existing manager queue links directly to affected shifts', async () => {
            await page.goto(`${home}?location=${org.locationId}`)
            const panel = page.getByRole('region', { name: 'Требует внимания', exact: true })
            await panel.getByRole('button', { name: /^Под контролем/ }).click()
            const entry = panel.locator('.attention-row').filter({ hasText: 'Изменилась доступность для смен' })
            await expect(entry).toHaveCount(1)
            await shot(page, 'manager-attention')
            await entry.getByRole('link', { name: /Проверить смены/ }).click()
            await expect(dialog().getByRole('button', { name: 'Смены · 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
          })
          await check('replacement search explains unavailable candidates and reassigns once', async () => {
            await dialog().getByRole('button', { name: 'Подобрать замену', exact: true }).click()
            const replacement = page.getByRole('dialog', { name: 'Подобрать замену', exact: true })
            await replacement.getByRole('button', { name: 'Показать недоступных', exact: true }).click()
            await expect(replacement.locator('.availability-candidates.is-unavailable input')).toBeDisabled()
            await expect(replacement.locator('.availability-candidates.is-unavailable')).toContainText('пересекающаяся смена')
            await shot(page, 'replacement-eligibility')
            await replacement.getByRole('searchbox', { name: 'Поиск сотрудника', exact: true }).fill('Орлова')
            await expect(replacement.getByRole('radio')).toHaveCount(1)
            await replacement.getByRole('radio').check()
            await expect.poll(() => replacement.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
            await shot(page, 'replacement')
            await replacement.getByRole('button', { name: 'Назначить замену', exact: true }).click()
            await expect(replacement).toHaveCount(0)
            await expect(dialog().getByRole('button', { name: 'Смены · 0', exact: true })).toBeVisible()
            assert.equal((await prisma.workShift.findUniqueOrThrow({ where: { id: shift.id } })).memberId, members[1].id)
          })
          await check('date exceptions replace one day and retry a lost response without duplicate history', async () => {
            await dialog().getByRole('button', { name: 'Исключения · 0', exact: true }).click()
            await dialog().getByRole('button', { name: '+ Добавить дату', exact: true }).click()
            const exception = page.getByRole('dialog', { name: 'Исключение на дату', exact: true })
            await date(exception, 'Дата', tuesday)
            await select('В этот день: доступность', 'Указать время', exception)
            await shot(page, 'exception-editor')
            await exception.getByRole('button', { name: 'Добавить в правила', exact: true }).click()
            await expect(dialog().locator('.exception-list article')).toHaveCount(1)
            await shot(page, 'date-exceptions')
            let dropped = false
            await page.route(`**/api/organizations/${org.id}/availability/${members[0].id}*`, async route => {
              if (route.request().method() !== 'POST' || dropped) return route.continue()
              dropped = true
              const response = await route.fetch()
              assert.equal(response.status(), 200)
              await route.abort('failed')
            })
            await dialog().getByRole('button', { name: 'Сохранить доступность', exact: true }).click()
            await expect(dialog().locator('.request-error-message')).toBeVisible()
            await dialog().getByRole('button', { name: 'Сохранить доступность', exact: true }).click()
            await expect(dialog().getByRole('button', { name: 'Смены · 0', exact: true })).toHaveAttribute('aria-pressed', 'true')
            assert.equal(await prisma.memberAvailabilityEvent.count({ where: { organizationId: org.id } }), 2)
            await page.unroute(`**/api/organizations/${org.id}/availability/${members[0].id}*`)
            await dialog().getByRole('button', { name: 'История', exact: true }).click()
            await expect(dialog().locator('.availability-history > article')).toHaveCount(2)
            await shot(page, 'history')
          })
          await check('employee edits own availability without approval and preserves the author in history', async () => {
            await employee.goto(`${schedule}&availability=own`)
            const ownDialog = employee.getByRole('dialog', { name: 'Моя доступность', exact: true })
            await expect(ownDialog.getByText('Соколов Михаил', { exact: true })).toBeVisible()
            await ownDialog.getByRole('button', { name: 'Исключения · 1', exact: true }).click()
            await shot(employee, 'own-availability')
            await ownDialog.getByRole('button', { name: '+ Добавить дату', exact: true }).click()
            const exception = employee.getByRole('dialog', { name: 'Исключение на дату', exact: true })
            await date(exception, 'Дата', nextDay(4), employee)
            await exception.getByRole('button', { name: 'Добавить в правила', exact: true }).click()
            await ownDialog.getByRole('button', { name: 'Сохранить доступность', exact: true }).click()
            await expect(ownDialog.getByRole('button', { name: 'Смены · 0', exact: true })).toHaveAttribute('aria-pressed', 'true')
            const event = await prisma.memberAvailabilityEvent.findFirst({ where: { organizationId: org.id }, orderBy: { revision: 'desc' } })
            assert.equal(event.actorMemberId, members[0].id)
            await employee.goto(`${schedule}&availability=${members[1].id}`)
            // The workspace deliberately binds ordinary employees to themselves.
            await expect(employee.getByRole('dialog', { name: 'Моя доступность', exact: true })).toContainText('Соколов Михаил')
          })
          await check('batch preview highlights dates and requires an explicit reason; stored shifts preserve it', async () => {
            await page.goto(schedule)
            await page.getByRole('button', { name: /Добавить смену/ }).first().click()
            const form = page.locator('.schedule-shift-dialog')
            await form.getByRole('combobox', { name: 'Сотрудник', exact: true }).click()
            await page.getByRole('combobox', { name: 'Поиск сотрудника', exact: true }).fill('Соколов')
            await page.getByRole('option').filter({ hasText: 'Соколов Михаил' }).click()
            await form.getByLabel('Добавить смены на несколько дат', { exact: true }).check()
            await form.getByRole('button', { name: 'Диапазон', exact: true }).click()
            const period = form.locator('.batch-editor__period')
            await date(period, 'С', nextDay(8))
            await date(period, 'По', nextDay(9))
            await period.getByRole('button', { name: 'Выбрать диапазон', exact: true }).click()
            await expect(form.locator('.batch-availability-note')).toHaveCount(1)
            await expect(form.getByRole('button', { name: 'Создать 2 смены', exact: true })).toBeDisabled()
            await shot(page, 'batch-warning')
            await form.getByRole('button', { name: 'Назначить по договорённости', exact: true }).click()
            await form.getByLabel('Причина назначения', { exact: true }).fill('Сотрудник подтвердил разовый выход')
            await shot(page, 'agreement')
            await form.getByRole('button', { name: 'Создать 2 смены', exact: true }).click()
            await expect(form).toHaveCount(0)
            const created = await prisma.workShift.findMany({ where: { organizationId: org.id, memberId: members[0].id } })
            assert.equal(created.length, 2)
            assert.equal(created.filter(item => item.availabilityOverride !== null).length, 1)
          })
          await check('an existing shift can be kept by agreement without changing its times', async () => {
            const existing = await prisma.workShift.create({ data: {
              organizationId: org.id, locationId: org.locationId, memberId: members[0].id,
              createdByMemberId: owner.id, scheduledStartAt: new Date(`${nextDay(15)}T07:00:00Z`),
              scheduledEndAt: new Date(`${nextDay(15)}T15:00:00Z`),
            } })
            await page.goto(`${schedule}&month=${nextDay(15).slice(0, 7)}&shift=${existing.id}`)
            await page.getByRole('button', { name: 'Изменить расписание', exact: true }).click()
            const form = page.getByRole('dialog', { name: 'Редактировать смену', exact: true })
            await form.getByRole('button', { name: 'Назначить по договорённости', exact: true }).click()
            await form.getByLabel('Причина назначения', { exact: true }).fill('Сотрудник подтвердил сохранение этой смены')
            await shot(page, 'existing-shift-agreement')
            await form.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
            await expect(form).toHaveCount(0)
            const saved = await prisma.workShift.findUniqueOrThrow({ where: { id: existing.id } })
            assert.equal(saved.scheduledStartAt.toISOString(), existing.scheduledStartAt.toISOString())
            assert.equal(saved.scheduledEndAt.toISOString(), existing.scheduledEndAt.toISOString())
            assert.equal(saved.availabilityOverride.reason, 'Сотрудник подтвердил сохранение этой смены')
          })
          await check('both themes fit small screens and keyboard-visible dialogs have no serious accessibility errors', async () => {
            await page.goto(availabilityUrl)
            await expect(dialog().getByRole('button', { name: 'По дням недели', exact: true })).toBeVisible()
            const axe = await new AxeBuilder({ page }).include('.availability-dialog').analyze()
            assert.deepEqual(axe.violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => ({ id: item.id, nodes: item.nodes.map(node => node.failureSummary) })), [])
            await shot(page, 'final-rules')
          })
          await check('existing member profile opens the same availability feature with its real subscription context', async () => {
            await dialog().getByRole('button', { name: 'Профиль сотрудника', exact: true }).click()
            const profile = page.locator('.member-profile-dialog')
            await expect(profile.locator('.availability-profile-shortcut')).toBeVisible()
            await shot(page, 'member-profile')
            await profile.locator('.availability-profile-shortcut').click()
            await expect(profile).toHaveCount(0)
            await expect(dialog()).toBeVisible()
            await expect(page.locator('.subscription-gate')).toHaveCount(0)
          })
          if (viewport === 'desktop') {
            await check('locked plan does not fetch availability or reopen a tariff popup on focus', async () => {
              await prisma.organizationSubscription.update({ where: { organizationId: org.id }, data: { plan: 'FREE', periodStart: null, periodEnd: null, trialEndsAt: null } })
              let reads = 0
              page.on('request', request => { if (request.url().includes('/api/') && /\/availability(?:-members|\/)/.test(request.url())) reads++ })
              await page.goto(availabilityUrl)
              await expect(page.getByRole('dialog', { name: 'Доступность сотрудников', exact: true })).toContainText('Доступно на тарифах')
              assert.equal(reads, 0)
              await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click()
              await page.evaluate(() => window.dispatchEvent(new Event('focus')))
              await expect(page.getByRole('dialog')).toHaveCount(0)
              await shot(page, 'locked-plan')
            })
          }
        } catch (error) {
          await page.screenshot({ path: path.join(output, `${prefix}-failure.png`), fullPage: true })
          await writeFile(path.join(output, `${prefix}-failure.txt`), await page.locator('body').innerText())
          throw error
        } finally {
          await context.close()
          await employeeContext.close()
        }
      }
    }
    assert.deepEqual(result.errors, [])
    result.status = 'passed'
    await save()
    return result
  } catch (error) {
    result.status = 'failed'
    result.errors.push(error.message)
    await save()
    throw error
  } finally {
    await browser.close()
    await server.close()
  }
}
