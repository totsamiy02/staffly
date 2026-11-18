import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'

export async function checkLifecycleBoundaries({ browser, page, origin, base, location, fixture, prisma, check, expect, result, output, name, viewport }) {
  const { saveAccessRole, saveMemberAccess } = await import('../../src/server/organizations/access/access-service.ts')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const { previewDeparture, confirmDeparture } = await import('../../src/server/organizations/departure-service.ts')
  const { previewSelfExit, leaveOrganization } = await import('../../src/server/organizations/self-exit-service.ts')
  const { createCodeInvitation, acceptCodeInvitation } = await import('../../src/server/organizations/invitation-service.ts')
  const { locationContext } = await import('../../src/server/organizations/location-context.ts')
  const person = fixture.people[0]
  const context = await browser.newContext({ viewport: page.viewportSize(), locale: 'ru-RU', reducedMotion: 'reduce' })
  const theme = await page.evaluate(() => localStorage.getItem('staffly.theme'))
  await context.addInitScript(value => {
    localStorage.setItem('staffly.theme', value ?? 'light')
    localStorage.setItem('staffly-cookie-consent', 'necessary')
  }, theme)
  await prisma.user.update({ where: { id: person.userId }, data: { passwordHash: fixture.owner.passwordHash } })
  const refresh = randomUUID() + randomUUID()
  const browserToken = randomBytes(48).toString('base64url')
  const session = await prisma.authSession.create({ data: {
    userId: person.userId,
    browserTokenHash: createHash('sha256').update(browserToken).digest('hex'),
    refreshTokenHash: createHash('sha256').update(refresh).digest('hex'),
    idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000),
  } })
  await context.addCookies(['staffly_refresh', 'staffly_browser'].map(key => ({
    name: key, value: key === 'staffly_refresh' ? refresh : browserToken,
    domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax',
  })))
  const employee = await context.newPage()
  const background = await context.newPage()
  let authorization
  for (const target of [employee, background]) {
    target.on('pageerror', error => result.errors.push({ browser: name, viewport, message: error.message }))
    target.on('request', request => {
      if (request.headers().authorization) authorization = request.headers().authorization
    })
  }
  const scoped = work => locationContext.run({ organizationId: fixture.org.id, locationId: fixture.org.locationId }, work)
  const privateTitle = `Личный документ ${randomUUID()}`
  const docId = fixture.document.id
  const documentUrl = `${origin}${base}/documents${location}&document=${docId}`
  const api = `/api/organizations/${fixture.org.id}`
  const shot = async (target, suffix) => {
    const file = `${name}-${viewport}-lifecycle-${suffix}.png`
    await target.mouse.move(0, 0)
    await target.screenshot({ path: path.join(output, file), fullPage: true })
    result.screenshots.push(file)
  }
  const safe = async target => {
    const body = await target.locator('body').innerText()
    assert.doesNotMatch(body, /PrismaClient|Invalid .*invocation|TypeError:|Cannot read properties|SQLSTATE|SELECT .* FROM|Unexpected token/)
    assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  }
  const view = ['members.view', 'documents.view', 'documents.download', 'events.view', 'requests.own', 'schedule.own']
  let role
  const changeRole = async permissions => {
    const initial = !role
    role = await scoped(() => saveAccessRole(fixture.owner.id, fixture.org.id, role?.id ?? null, {
      name: 'Проверка границ', description: '', permissions, ...(role ? { revision: role.revision } : {}),
    }))
    if (initial) await scoped(() => saveMemberAccess(fixture.owner.id, fixture.org.id, person.id, {
      organizationRoleId: null, assignments: [{ locationId: fixture.org.locationId, roleId: role.id }],
    }))
  }
  try {
    await prisma.document.update({ where: { id: docId }, data: { displayName: privateTitle } })
    await changeRole(view)
    await employee.goto(documentUrl)
    await expect(employee.locator('.document-viewer h2')).toHaveText(privateTitle)
    await check('lifecycle: open document loses its download action when the role changes without reload', async () => {
      await expect(employee.getByRole('button', { name: 'Скачать', exact: true })).toBeVisible()
      await changeRole(view.filter(permission => permission !== 'documents.download'))
      await expect(employee.getByRole('button', { name: 'Скачать', exact: true })).toHaveCount(0, { timeout: 15000 })
      await expect(employee.locator('.document-viewer h2')).toHaveText(privateTitle)
      const denied = await employee.request.post(`${origin}${api}/documents/${docId}/content?action=download&locationId=${fixture.org.locationId}`, { headers: { Authorization: authorization } })
      assert.equal(denied.status(), 403)
      await shot(employee, 'download-revoked')
    })
    await check('lifecycle: revoked document access removes cached title, file preview and actions from the open card', async () => {
      await prisma.document.update({ where: { id: docId }, data: { visibility: 'SELECTED', audienceMemberIds: [fixture.member.id] } })
      await expect(employee.locator('.document-viewer .request-error-state')).toBeVisible({ timeout: 15000 })
      await expect(employee.locator('.document-viewer')).not.toContainText(privateTitle)
      await expect(employee.getByRole('button', { name: 'Скачать', exact: true })).toHaveCount(0)
      await expect(employee.locator('.document-viewer-main')).toHaveCount(0)
      await shot(employee, 'document-revoked')
      await safe(employee)
    })
    await check('lifecycle: removing an event recipient clears the open event title and participants', async () => {
      await prisma.eventRecipient.create({ data: { organizationId: fixture.org.id, eventId: fixture.event.id, memberId: person.id } })
      await employee.goto(`${origin}${base}/events${location}&event=${fixture.event.id}`)
      await expect(employee.locator('.event-detail-dialog h2')).toHaveText(fixture.event.title)
      await prisma.eventRecipient.update({ where: { eventId_memberId: { eventId: fixture.event.id, memberId: person.id } }, data: { removedAt: new Date() } })
      await expect(employee.locator('.event-detail-dialog')).toContainText('Не удалось загрузить события', { timeout: 15000 })
      await expect(employee.locator('.event-detail-dialog')).not.toContainText(fixture.event.title)
      await expect(employee.locator('.event-recipients')).toHaveCount(0)
      await shot(employee, 'event-revoked')
      await employee.locator('.event-detail-dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
    })
    await check('lifecycle: a request card remains closable after the manager loses access to another employee request', async () => {
      await changeRole([...view, 'requests.view'])
      const request = await prisma.organizationRequest.findFirstOrThrow({ where: { organizationId: fixture.org.id, createdByMemberId: { not: person.id } } })
      await employee.goto(`${origin}${base}/requests${location}&tab=incoming&request=${request.id}`)
      await expect(employee.locator('.request-detail-person')).toBeVisible()
      await changeRole(view)
      await expect(employee.getByRole('dialog')).toContainText('Не удалось открыть заявку', { timeout: 15000 })
      await expect(employee.locator('.request-detail-person')).toHaveCount(0)
      await shot(employee, 'request-revoked')
      await employee.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
      await expect(employee.getByRole('dialog')).toHaveCount(0)
    })
    await check('lifecycle: malformed, missing and unauthorized resource links stay safe and can be closed', async () => {
      for (const id of ['invalid-id', randomUUID(), docId]) {
        await employee.goto(`${origin}${base}/documents${location}&document=${id}`)
        await expect(employee.locator('.document-viewer .request-error-state')).toBeVisible()
        await expect(employee.locator('.document-viewer')).not.toContainText(privateTitle)
        await expect(employee.locator('.document-viewer .request-error-reference')).toHaveCount(0)
        await employee.locator('.document-viewer').getByRole('button', { name: 'Закрыть', exact: true }).click()
        await expect(employee.locator('.document-viewer')).toHaveCount(0)
        await safe(employee)
      }
      await employee.goto(`${origin}${base}/requests${location}&request=${randomUUID()}`)
      await expect(employee.getByRole('dialog')).toContainText('Не удалось открыть заявку')
      await safe(employee)
      await employee.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
      await employee.goto(`${origin}${base}/unknown-module${location}`)
      await expect(employee.getByRole('heading', { name: 'Такого раздела нет', exact: true })).toBeVisible()
      await employee.getByRole('link', { name: 'На главную организации', exact: true }).click()
      await expect(employee.locator('.workspace-content')).toBeVisible()
      await shot(employee, 'recovered-navigation')
    })
    let other
    await check('lifecycle: foreign organization and foreign point links cannot reuse a previously opened workspace', async () => {
      other = await createBusinessOrganization(fixture.owner.id, { name: `Закрытая организация ${randomUUID()}`, timezone: 'Europe/Moscow', description: null })
      for (const address of [
        `${origin}/app/organizations/${other.id}/documents`,
        `${origin}${base}/documents?location=${other.locationId}`,
        `${origin}/app/organizations/not-an-id/schedule`,
      ]) {
        await employee.goto(address)
        await expect(employee.locator('.workspace-load-error')).toBeVisible()
        await expect(employee.locator('.workspace-load-error')).not.toContainText(privateTitle)
        await safe(employee)
      }
      await shot(employee, 'foreign-workspace')
    })
    await check('lifecycle: manager exclusion removes an open document in two tabs and rehire restores no managerial powers', async () => {
      await prisma.document.update({ where: { id: docId }, data: { visibility: 'ORGANIZATION', audienceMemberIds: [] } })
      await employee.goto(documentUrl)
      await background.goto(documentUrl)
      await expect(employee.locator('.document-viewer h2')).toHaveText(privateTitle)
      const preview = await scoped(() => previewDeparture(fixture.owner.id, fixture.org.id, person.id, 'organization'))
      await scoped(() => confirmDeparture(fixture.owner.id, fixture.org.id, person.id, {
        scope: 'organization', token: preview.token, reason: 'Проверка завершения участия сотрудника',
        choices: preview.shifts.filter(shift => !shift.current).map(shift => ({ shiftId: shift.id, action: 'cancel' })),
        keepCurrent: true, acknowledgeDrafts: true, acknowledgeWorkload: true,
      }))
      for (const target of [employee, background]) {
        await expect(target.locator('.workspace-load-error')).toBeVisible({ timeout: 20000 })
        await expect(target.locator('.document-viewer')).toHaveCount(0)
      }
      assert.equal((await employee.request.get(`${origin}${api}/documents/${docId}?locationId=${fixture.org.locationId}`, { headers: { Authorization: authorization } })).status(), 404)
      await shot(employee, 'excluded-open-tabs')
      const invite = await scoped(() => createCodeInvitation(fixture.owner.id, fixture.org.id))
      const user = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } })
      await acceptCodeInvitation(person.userId, user.email, invite.code)
      assert.equal(await prisma.accessAssignment.count({ where: { organizationId: fixture.org.id, memberId: person.id } }), 0)
      assert.equal(await prisma.memberEmploymentPeriod.count({ where: { memberId: person.id } }), 2)
      await employee.goto(`${origin}${base}/schedule${location}`)
      await expect(employee.locator('.workspace-content')).toBeVisible()
      await expect(employee.getByRole('button', { name: /Добавить смену/ })).toHaveCount(0)
    })
    await check('lifecycle: leaving removes access in both open tabs and old API tokens while preserving the account', async () => {
      await prisma.document.update({ where: { id: docId }, data: { visibility: 'ORGANIZATION', audienceMemberIds: [] } })
      await employee.goto(documentUrl)
      await background.goto(`${origin}${base}/requests${location}&tab=mine`)
      await expect(employee.locator('.document-viewer h2')).toHaveText(privateTitle)
      const preview = await previewSelfExit(person.userId, fixture.org.id)
      await leaveOrganization(person.userId, fixture.org.id, preview.employmentPeriodId)
      for (const target of [employee, background]) {
        await target.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect(target.locator('.workspace-load-error')).toBeVisible({ timeout: 20000 })
        await expect(target.locator('.document-viewer')).toHaveCount(0)
      }
      const denied = await employee.request.get(`${origin}${api}/documents/${docId}?locationId=${fixture.org.locationId}`, { headers: { Authorization: authorization } })
      assert.equal(denied.status(), 404)
      assert.equal((await employee.request.get(`${origin}/api/profile`, { headers: { Authorization: authorization } })).status(), 200)
      await shot(employee, 'departed-open-tab')
      const invite = await scoped(() => createCodeInvitation(fixture.owner.id, fixture.org.id))
      const user = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } })
      await acceptCodeInvitation(person.userId, user.email, invite.code)
      await assert.rejects(leaveOrganization(person.userId, fixture.org.id, preview.employmentPeriodId), error => error.code === 'MEMBERSHIP_CHANGED')
      await employee.goto(`${origin}${base}/schedule${location}`)
      await expect(employee.locator('.workspace-content')).toBeVisible()
      await expect(employee.getByRole('button', { name: /Добавить смену/ })).toHaveCount(0)
      assert.equal(await prisma.memberEmploymentPeriod.count({ where: { memberId: person.id } }), 3)
    })
    await check('lifecycle: revoked authentication rejects a saved bearer token and returns a private link to sign-in', async () => {
      await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      const denied = await employee.request.get(`${origin}/api/profile`, { headers: { Authorization: authorization } })
      assert.equal(denied.status(), 401)
      await employee.goto(documentUrl)
      await expect(employee.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()
      await expect(employee.locator('.document-viewer')).toHaveCount(0)
      await safe(employee)
      await shot(employee, 'session-revoked')
    })
  } catch (error) {
    await shot(employee, 'failure')
    await writeFile(path.join(output, `${name}-${viewport}-lifecycle-failure.txt`), await employee.locator('body').innerText())
    throw error
  } finally {
    await context.close()
  }
}
