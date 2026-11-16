import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import AxeBuilder from '@axe-core/playwright'
import sharp from 'sharp'

export async function runSelfExit({ prisma, env, root, temporary, output, options, startApi }) {
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
    cacheDir: path.join(temporary, 'vite-self-exit'),
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
  const save = () => writeFile(path.join(output, 'self-exit.json'), JSON.stringify(result, null, 2))
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
            email: `self-exit-${randomUUID()}@example.test`, passwordHash: 'synthetic-only',
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
        const position = await prisma.organizationPosition.create({ data: { organizationId: org.id, name: 'Бариста' } })
        await prisma.memberPosition.createMany({ data: members.map(member => ({ memberId: member.id, positionId: position.id })) })
        const start = new Date(Date.now() + 3 * 86400000)
        start.setUTCHours(6, 0, 0, 0)
        const shifts = []
        for (const days of [0, 1]) {
          shifts.push(await prisma.workShift.create({ data: {
            organizationId: org.id, locationId: org.locationId, memberId: members[0].id,
            positionId: position.id, positionNameSnapshot: position.name, createdByMemberId: owner.id,
            scheduledStartAt: new Date(+start + days * 86400000), scheduledEndAt: new Date(+start + days * 86400000 + 8 * 3600000),
          } }))
        }
        const type = await prisma.requestType.create({ data: {
          organizationId: org.id, name: 'Передать инструкции по открытию', dateMode: 'NONE', requiresComment: false,
        } })
        const task = await prisma.organizationRequest.create({ data: {
          organizationId: org.id, locationId: org.locationId, createdByMemberId: owner.id,
          requestTypeId: type.id, typeNameSnapshot: type.name, status: 'APPROVED',
          formSnapshot: { version: 1, visibility: 'TEAM', stages: [{ name: 'Согласование', memberId: owner.id }] },
          outcome: { kind: 'TASK', status: 'OPEN', text: 'Передать инструкции по открытию', assignees: [members[0].id], deadline: start.toISOString().slice(0, 10) },
        } })
        await createBusinessOrganization(people[1].id, { name: 'Пекарня «Тёплый хлеб»', description: null, timezone: 'Europe/Moscow' })
        const context = await session(people[1].id, theme, viewport)
        const managerContext = await session(people[0].id, theme, viewport)
        const page = await context.newPage()
        const manager = await managerContext.newPage()
        const background = await context.newPage()
        for (const target of [page, manager, background]) {
          target.on('pageerror', error => result.errors.push({ prefix, error: error.message }))
        }
        const home = `${origin}/app/organizations/${org.id}?location=${org.locationId}`
        const fit = async target => {
          await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
          const dialog = target.getByRole('dialog').last()
          if (await dialog.isVisible()) {
            const bounds = await dialog.boundingBox()
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
        const check = async (name, action) => {
          await action()
          result.checks.push({ prefix, name })
          await save()
        }
        try {
          await page.goto(`${origin}/app`)
          await background.goto(home)
          await expect(background.locator('.workspace-content')).toBeVisible()
          await check('organization menu does not navigate and confirmation describes real remaining work', async () => {
            await page.getByLabel(`Действия организации: ${org.name}`, { exact: true }).click()
            await shot(page, 'menu')
            await page.getByRole('button', { name: 'Покинуть организацию', exact: true }).click()
            const dialog = page.getByRole('dialog', { name: 'Покинуть организацию?', exact: true })
            await expect(dialog).toContainText('Будущих смен: 2. Незавершённых задач: 1.')
            const axe = await new AxeBuilder({ page }).include('.self-leave-dialog').analyze()
            assert.deepEqual(axe.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.failureSummary) })), [])
            await shot(page, 'confirmation')
          })
          await check('lost response can be retried without duplicate departure; other organization and account survive', async () => {
            let dropped = false
            await page.route(`**/api/organizations/${org.id}/leave`, async route => {
              if (route.request().method() !== 'POST' || dropped) return route.continue()
              dropped = true
              const response = await route.fetch()
              assert.equal(response.status(), 200)
              await route.abort('failed')
            })
            await page.getByRole('dialog').getByRole('button', { name: 'Покинуть организацию', exact: true }).click()
            await page.getByRole('button', { name: 'Повторить выход', exact: true }).click()
            await expect(page.getByRole('dialog')).toHaveCount(0)
            await expect(page.locator('.exit-success')).toContainText(org.name)
            await expect(page.locator('.organization-card__link')).toHaveCount(1)
            assert.equal(await prisma.memberSelfExit.count({ where: { organizationId: org.id } }), 1)
            await shot(page, 'success')
          })
          await check('another open tab loses organization access and cannot fetch old work', async () => {
            await background.bringToFront()
            await background.evaluate(() => window.dispatchEvent(new Event('focus')))
            await expect(background.locator('.workspace-load-error')).toBeVisible({ timeout: 20000 })
          })
          await manager.goto(`${origin}/app`)
          await check('owner is directed to existing ownership transfer without leaving', async () => {
            await manager.getByLabel(`Действия организации: ${org.name}`, { exact: true }).click()
            await manager.getByRole('button', { name: 'Покинуть организацию', exact: true }).click()
            const dialog = manager.getByRole('dialog', { name: 'Сначала передайте владение', exact: true })
            await expect(dialog.getByRole('link', { name: 'Передать владение', exact: true })).toHaveAttribute('href', `/app/organizations/${org.id}/settings?section=access`)
            await shot(manager, 'owner')
            await dialog.getByRole('button', { name: 'Остаться', exact: true }).click()
          })
          await manager.goto(home)
          await check('one manager attention entry leads to remaining assignments', async () => {
            const panel = manager.getByRole('region', { name: 'Требует внимания', exact: true })
            await panel.getByRole('button', { name: /^Под контролем/ }).click()
            const card = panel.locator('.attention-row').filter({ hasText: 'Соколов Михаил покинул организацию' })
            await expect(card).toHaveCount(1)
            await shot(manager, 'attention')
            await card.getByRole('link', { name: 'Разобрать' }).click()
            await expect(manager.getByRole('dialog', { name: 'После выхода сотрудника', exact: true })).toContainText('Смены · 2')
            const axe = await new AxeBuilder({ page: manager }).include('.left-shifts-dialog').analyze()
            assert.deepEqual(axe.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.failureSummary) })), [])
            // A former member's personal avatar stays private under the existing media policy.
            await expect(manager.locator('.left-shifts-dialog .leave-identity .media-avatar')).toHaveText('С')
            await expect(manager.locator('.left-shifts-dialog .leave-identity img')).toHaveCount(0)
            await shot(manager, 'remaining-shifts')
          })
          await check('replacement search and normal shift mutation preserve history', async () => {
            await manager.getByRole('button', { name: 'Подобрать замену', exact: true }).first().click()
            const picker = manager.getByRole('dialog', { name: 'Подобрать замену', exact: true })
            await picker.getByRole('searchbox', { name: 'Поиск сотрудника' }).fill('Орлова')
            await expect(picker.getByRole('radio')).toHaveCount(1)
            await picker.getByRole('radio').check()
            await expect.poll(() => picker.locator('.self-exit-candidates img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
            await shot(manager, 'replacement')
            await picker.getByRole('button', { name: 'Назначить', exact: true }).click()
            await expect(picker).toHaveCount(0)
            await expect(manager.getByRole('button', { name: 'Смены · 1', exact: true })).toBeVisible()
            const changed = await prisma.workShift.findUniqueOrThrow({ where: { id: shifts[0].id } })
            assert.equal(changed.memberId, members[1].id)
            assert.equal(changed.status, 'SCHEDULED')
            assert.equal(changed.selfExitId, null)
            assert.equal(await prisma.workShiftAdjustment.count({ where: { shiftId: changed.id, kind: 'TRANSFER' } }), 1)
          })
          await check('task reassignment retains its deadline and unfinished shift stays actionable', async () => {
            await manager.getByRole('button', { name: 'Задачи · 1', exact: true }).click()
            await shot(manager, 'remaining-tasks')
            await manager.getByRole('button', { name: 'Назначить исполнителя', exact: true }).click()
            const picker = manager.getByRole('dialog', { name: 'Назначить исполнителя', exact: true })
            await picker.getByRole('searchbox', { name: 'Поиск сотрудника' }).fill('Орлова')
            await picker.getByRole('radio').check()
            await picker.getByRole('button', { name: 'Назначить', exact: true }).click()
            await expect(picker).toHaveCount(0)
            const updated = await prisma.organizationRequest.findUniqueOrThrow({ where: { id: task.id } })
            assert.deepEqual(updated.outcome.assignees, [members[1].id])
            assert.equal(updated.outcome.deadline, start.toISOString().slice(0, 10))
            await manager.getByRole('button', { name: 'Смены · 1', exact: true }).click()
          })
          await check('calendar keeps vacancies clear and excludes them from estimated hours', async () => {
            const date = shifts[1].scheduledStartAt
            await manager.goto(`${origin}/app/organizations/${org.id}/schedule?location=${org.locationId}&month=${date.toISOString().slice(0, 7)}`)
            await expect(manager.getByRole('region', { name: 'Смены, требующие замены', exact: true })).toBeVisible()
            await shot(manager, 'calendar')
            await manager.getByRole('link', { name: 'Показать смены', exact: true }).click()
            await expect(manager.getByRole('dialog', { name: 'После выхода сотрудника', exact: true })).toContainText('Нужна замена')
            await manager.getByRole('button', { name: 'Отменить смену', exact: true }).click()
            await expect(manager.getByRole('dialog', { name: 'После выхода сотрудника', exact: true })).toContainText('Все доступные рабочие назначения обработаны.')
          })
          if (viewport === 'desktop') {
            await check('expired and suspended organization without active point still allows self exit through HTTP', async () => {
              const paused = await createBusinessOrganization(people[0].id, { name: 'Закрытая точка', description: null, timezone: 'Europe/Moscow' })
              await prisma.organizationMember.create({ data: { organizationId: paused.id, userId: people[1].id, accessConfigured: true } })
              const yesterday = new Date(Date.now() - 86400000)
              await prisma.organizationSubscription.update({ where: { organizationId: paused.id }, data: {
                periodStart: new Date(+yesterday - 86400000), periodEnd: yesterday, trialStartedAt: null, trialEndsAt: null,
              } })
              await prisma.organization.update({ where: { id: paused.id }, data: { serviceState: 'SUSPENDED', serviceReason: 'Synthetic UI check' } })
              await page.goto(`${origin}/app`)
              await page.getByLabel(`Действия организации: ${paused.name}`, { exact: true }).click()
              await page.getByRole('button', { name: 'Покинуть организацию', exact: true }).click()
              const dialog = page.getByRole('dialog', { name: 'Покинуть организацию?', exact: true })
              await expect(dialog).toContainText('Рабочих точек: 0')
              await dialog.getByRole('button', { name: 'Покинуть организацию', exact: true }).click()
              await expect(page.locator('.exit-success')).toContainText(paused.name)
              assert.equal(await prisma.memberSelfExit.count({ where: { organizationId: paused.id } }), 1)
            })
          }
          result.checks.push({ prefix, name: 'responsive layout for every changed surface' })
        } catch (error) {
          for (const [name, target] of [['employee', page], ['manager', manager], ['background', background]]) {
            await target.screenshot({ path: path.join(output, `${prefix}-${name}-failure.png`), fullPage: true })
            await writeFile(path.join(output, `${prefix}-${name}-failure.txt`), await target.locator('body').innerText())
          }
          throw error
        } finally {
          await context.close()
          await managerContext.close()
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
