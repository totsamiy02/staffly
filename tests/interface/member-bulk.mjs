import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import AxeBuilder from '@axe-core/playwright'
import sharp from 'sharp'

export async function runMemberBulk({ prisma, env, root, temporary, output, options, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true')
  assert(path.resolve(env.LOCAL_STORAGE_ROOT).startsWith(path.resolve(temporary) + path.sep))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, expect } = await import('playwright/test')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const { storage } = await import('../../src/server/storage/provider.ts')
  const socket = socketServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin; env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi()
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-cache'), plugins: [react(), devApiProxy(Number(new URL(api).port))], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true })
  const result = { status: 'running', checks: [], screenshots: [], errors: [] }
  const save = () => writeFile(path.join(output, 'member-bulk.json'), JSON.stringify(result, null, 2))
  const themes = options.theme ? [options.theme] : ['light', 'dark']
  try {
    for (const theme of themes) for (const viewport of [
      { name: 'desktop', width: 1440, height: 1050 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 390, height: 844 },
      { name: 'narrow', width: 320, height: 780 },
    ]) {
      const owner = await prisma.user.create({ data: { email: `bulk-ui-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Анна', lastName: 'Смирнова' } })
      const org = await createBusinessOrganization(owner.id, { name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'Центральная', timezone: 'Europe/Moscow', city: 'Москва', address: 'Лесная, 8' }, locations: [{ name: 'Северная', timezone: 'Europe/Moscow', city: 'Москва', address: 'Новослободская, 24' }] })
      const [central, north] = org.locations
      const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } })
      const people = []
      for (const [index, [firstName, lastName]] of [['Михаил', 'Соколов'], ['Екатерина', 'Орлова'], ['Ольга', 'Лебедева']].entries()) {
        const user = await prisma.user.create({ data: { email: `bulk-ui-person-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName, lastName } })
        const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } })
        await prisma.locationMember.create({ data: { organizationId: org.id, locationId: index === 2 ? north.id : central.id, memberId: member.id } })
        const portrait = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${['#c9dcd7','#dacbdc','#d3d9e5'][index]}"/><ellipse cx="48" cy="90" rx="34" ry="29" fill="${['#426958','#61516c','#4d6081'][index]}"/><circle cx="48" cy="39" r="23" fill="#e3baa1"/><path d="M25 37Q24 9 48 12Q74 9 71 39L65 24Q47 34 29 27Z" fill="#493a35"/><circle cx="40" cy="40" r="2" fill="#493a35"/><circle cx="56" cy="40" r="2" fill="#493a35"/><path d="M42 51Q48 55 54 51" fill="none" stroke="#98635b" stroke-width="2"/></svg>`)).webp().toBuffer()
        const objectKey = `users/${user.id}/avatars/${randomUUID()}.webp`
        await storage.put(objectKey, portrait)
        const avatar = await prisma.storedFile.create({ data: { uploadedByUserId: user.id, purpose: 'USER_AVATAR', objectKey, mimeType: 'image/webp', size: portrait.length, checksumSha256: createHash('sha256').update(portrait).digest('hex') } })
        await prisma.user.update({ where: { id: user.id }, data: { avatarFileId: avatar.id } })
        people.push({ ...member, firstName, lastName })
      }
      const [a, b, c] = people
      const position = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Бариста' } })
      const cashier = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Кассир' } })
      await prisma.memberPosition.createMany({ data: [{ memberId: a.id, positionId: cashier.id }, { memberId: b.id, positionId: position.id }] })
      const bytes = Buffer.from('Регламент работы с кассой. Подтвердите ознакомление.')
      const objectKey = `organizations/${org.id}/documents/${randomUUID()}.txt`
      await storage.put(objectKey, bytes)
      const file = await prisma.storedFile.create({ data: { organizationId: org.id, uploadedByUserId: owner.id, purpose: 'DOCUMENT', objectKey, mimeType: 'text/plain', size: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') } })
      const document = await prisma.document.create({ data: { organizationId: org.id, locationId: central.id, storedFileId: file.id, uploadedByMemberId: ownerMember.id, visibility: 'SELECTED', audienceMemberIds: [a.id, b.id], displayName: 'Регламент работы с кассой', fileName: 'rules.txt' } })
      await prisma.documentAcknowledgement.create({ data: { documentId: document.id, memberId: b.id, assignedByMemberId: ownerMember.id } })
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' })
      try {
        await context.addInitScript(value => { localStorage.setItem('staffly.theme', value); localStorage.setItem('staffly-cookie-consent', 'necessary') }, theme)
        const token = randomUUID() + randomUUID(), browserToken = randomBytes(48).toString('base64url')
        await prisma.authSession.create({ data: { userId: owner.id, browserTokenHash: createHash('sha256').update(browserToken).digest('hex'), refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
        await context.addCookies([{ name: 'staffly_refresh', value: token, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }, { name: 'staffly_browser', value: browserToken, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }])
        const page = await context.newPage()
        page.on('pageerror', error => result.errors.push(error.message))
        const home = `${origin}/app/organizations/${org.id}`
        const screenshot = async (name, modal = false) => {
          while (await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).count()) await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).first().click()
          const fileName = `${theme}-${viewport.name}-${name}.png`
          await page.screenshot({ path: path.join(output, fileName), fullPage: !modal })
          result.screenshots.push(fileName)
        }
        const check = async (name, run) => { await run(); result.checks.push({ theme, viewport: viewport.name, name }); await save() }
        const layout = async dialog => {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
          const box = await dialog.boundingBox()
          assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify(box))
          assert.deepEqual((await new AxeBuilder({ page }).include('.member-bulk-dialog').analyze()).violations, [])
        }
        await page.goto(`${home}/settings?section=schedule`)
        await page.getByRole('button', { name: 'Должности', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Должности', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.planning-position-items > div').filter({ hasText: 'Бариста' }).getByRole('button', { name: 'Назначить сотрудникам', exact: true })).toBeVisible()
        await screenshot('positions-page')
        await page.locator('.planning-position-items > div').filter({ hasText: 'Бариста' }).getByRole('button', { name: 'Назначить сотрудникам', exact: true }).click()
        const positions = page.getByRole('dialog', { name: 'Назначить должность', exact: true })
        await check('real avatars, scope and responsive position dialog', async () => {
          await expect(positions.getByRole('checkbox', { name: 'Выбрать: Орлова Екатерина', exact: true })).toBeDisabled()
          for (const name of ['Лебедева Ольга', 'Орлова Екатерина', 'Соколов Михаил']) {
            const avatar = positions.getByRole('checkbox', { name: `Выбрать: ${name}`, exact: true }).locator('..').locator('.member-bulk-avatar')
            await avatar.scrollIntoViewIfNeeded()
            await expect(avatar).toBeVisible()
            await expect.poll(() => avatar.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length)).toBe(1)
          }
          await positions.getByRole('checkbox', { name: 'Выбрать: Соколов Михаил', exact: true }).check()
          await positions.getByRole('checkbox', { name: 'Выбрать: Лебедева Ольга', exact: true }).check()
          await layout(positions)
          await positions.locator('.member-bulk-body').evaluate(element => { element.scrollTop = 0 })
          await screenshot('position-selection', true)
        })
        await check('lost response repeats the same operation without duplicate assignments', async () => {
          const route = url => url.pathname === `/api/organizations/${org.id}/member-actions`
          let dropResponse = true
          let interrupted = 0
          await page.route(route, async intercepted => {
            if (dropResponse && intercepted.request().method() === 'POST') {
              interrupted += 1
              await intercepted.fetch()
              await intercepted.abort('failed')
            } else await intercepted.continue()
          })
          await positions.getByRole('button', { name: 'Назначить 2 сотрудникам', exact: true }).click()
          await expect.poll(() => interrupted).toBeGreaterThan(0)
          await expect(positions.getByRole('alert')).toBeVisible()
          dropResponse = false
          await positions.getByRole('button', { name: 'Назначить 2 сотрудникам', exact: true }).click()
          await expect(positions.locator('.member-bulk-summary')).toContainText('Выполнено: 2')
          assert.equal(await prisma.memberBulkOperation.count({ where: { organizationId: org.id } }), 1)
          assert.equal(await prisma.memberPosition.count({ where: { memberId: a.id } }), 2)
          assert.equal(await prisma.memberPosition.count({ where: { positionId: position.id } }), 3)
          await screenshot('position-result', true)
          await page.unroute(route)
          await positions.getByRole('button', { name: 'Готово', exact: true }).click()
          await expect(positions).toBeHidden()
        })
        await page.goto(`${home}/settings?section=locations`)
        await expect(page.locator('.location-settings-item')).toHaveCount(2)
        await screenshot('locations-page')
        await page.locator('.location-settings-item').filter({ hasText: 'Северная' }).getByRole('button', { name: 'Добавить сотрудников', exact: true }).click()
        const location = page.getByRole('dialog', { name: 'Добавить сотрудников', exact: true })
        await check('location assignment preserves positions, roles and previous location', async () => {
          await expect(location.getByRole('checkbox', { name: 'Выбрать: Лебедева Ольга', exact: true })).toBeDisabled()
          await location.getByRole('checkbox', { name: 'Выбрать: Соколов Михаил', exact: true }).check()
          await layout(location)
          await screenshot('location-selection', true)
          await location.getByRole('button', { name: 'Добавить 1 сотрудника', exact: true }).click()
          await expect(location.locator('.member-bulk-summary')).toContainText('Выполнено: 1')
          assert.equal(await prisma.locationMember.count({ where: { memberId: a.id, leftAt: null } }), 2)
          assert.equal(await prisma.memberPosition.count({ where: { memberId: a.id } }), 2)
          await location.getByRole('button', { name: 'Готово', exact: true }).click()
        })
        await page.goto(`${home}/documents`)
        await expect(page.locator('.document-row').filter({ hasText: document.displayName })).toBeVisible()
        await screenshot('documents-page')
        await page.locator('.document-row').filter({ hasText: document.displayName }).locator('summary').click()
        await page.getByRole('button', { name: 'Назначить ознакомление', exact: true }).click()
        const recipients = page.getByRole('dialog', { name: 'Получатели ознакомления', exact: true })
        await check('document access, deadline and cancellation are visible before one save', async () => {
          await expect(recipients.getByRole('checkbox', { name: 'Выбрать: Лебедева Ольга', exact: true })).toBeDisabled()
          await expect(recipients).toContainText('Нет доступа к документу или его папке.')
          const memberRole = await prisma.accessRole.findFirstOrThrow({ where: { organizationId: org.id, systemCode: 'MEMBER' } })
          await recipients.getByRole('combobox', { name: 'Добавить по роли', exact: true }).click()
          await page.getByRole('option', { name: memberRole.name, exact: true }).click()
          await expect(recipients.getByRole('checkbox', { name: 'Выбрать: Соколов Михаил', exact: true })).toBeChecked()
          await recipients.getByRole('checkbox', { name: 'Выбрать: Орлова Екатерина', exact: true }).uncheck()
          await recipients.getByLabel('Срок для новых получателей').fill('2026-11-28')
          await expect(recipients.locator('.member-bulk-summary')).toContainText('Будет отменено: 1')
          await layout(recipients)
          await screenshot('document-selection', true)
          await recipients.getByRole('button', { name: 'Сохранить получателей', exact: true }).click()
          await expect(recipients.locator('.member-bulk-summary')).toContainText('Выполнено: 2')
          const assigned = await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: document.id, memberId: a.id } } })
          assert.equal(assigned.deadline.toISOString().slice(0, 10), '2026-11-28')
          assert((await prisma.documentAcknowledgement.findUniqueOrThrow({ where: { documentId_memberId: { documentId: document.id, memberId: b.id } } })).cancelledAt)
          assert.equal(await prisma.documentAcknowledgement.count({ where: { documentId: document.id, memberId: c.id } }), 0)
          assert.equal(await prisma.accountNotification.count({ where: { documentId: document.id, userId: a.userId, type: 'DOCUMENT_ASSIGNED' } }), 1)
          await screenshot('document-result', true)
          await recipients.getByRole('button', { name: 'Готово', exact: true }).click()
        })
        if (viewport.name === 'desktop') await check('a role with assignment rights can reach settings without creating positions or seeing other locations', async () => {
          const role = await prisma.accessRole.create({ data: { organizationId: org.id, name: 'Назначение должностей', permissions: ['members.view', 'members.positions'] } })
          await prisma.organizationMember.update({ where: { id: b.id }, data: { accessConfigured: true } })
          await prisma.accessAssignment.create({ data: { organizationId: org.id, memberId: b.id, locationId: central.id, roleId: role.id } })
          const limited = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ru-RU', reducedMotion: 'reduce' })
          try {
            await limited.addInitScript(value => { localStorage.setItem('staffly.theme', value); localStorage.setItem('staffly-cookie-consent', 'necessary') }, theme)
            const refreshToken = randomUUID() + randomUUID()
            const browserKey = randomBytes(48).toString('base64url')
            await prisma.authSession.create({ data: { userId: b.userId, browserTokenHash: createHash('sha256').update(browserKey).digest('hex'), refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
            await limited.addCookies([{ name: 'staffly_refresh', value: refreshToken, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }, { name: 'staffly_browser', value: browserKey, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }])
            const managerPage = await limited.newPage()
            await managerPage.goto(`${home}/settings?section=schedule&planning=positions&location=${central.id}`)
            await expect(managerPage.getByRole('heading', { name: 'Должности организации', exact: true })).toBeVisible()
            await expect(managerPage.getByRole('textbox', { name: 'Новая должность', exact: true })).toHaveCount(0)
            await expect(managerPage.getByRole('button', { name: 'Изменить', exact: true })).toHaveCount(0)
            await managerPage.locator('.planning-position-items > div').filter({ hasText: 'Бариста' }).getByRole('button', { name: 'Назначить сотрудникам', exact: true }).click()
            const assignment = managerPage.getByRole('dialog', { name: 'Назначить должность', exact: true })
            await expect(assignment.getByRole('checkbox', { name: 'Выбрать: Соколов Михаил', exact: true })).toBeVisible()
            await expect(assignment.getByRole('checkbox', { name: 'Выбрать: Лебедева Ольга', exact: true })).toHaveCount(0)
          } finally { await limited.close() }
        })
      } catch (error) {
        const failedPage = context.pages()[0]
        if (failedPage) {
          await failedPage.screenshot({ path: path.join(output, `${theme}-${viewport.name}-failure.png`), fullPage: true }).catch(() => {})
          await writeFile(path.join(output, `${theme}-${viewport.name}-failure.txt`), await failedPage.locator('body').innerText().catch(() => ''))
        }
        throw error
      } finally { await context.close() }
    }
    assert.deepEqual(result.errors, [])
    result.status = 'passed'; await save(); return result
  } catch (error) { result.status = 'failed'; result.errors.push(error.message); await save(); throw error }
  finally { await browser.close(); await server.close() }
}
