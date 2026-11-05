import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { createServer as netServer } from 'node:net'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

export async function runWorkspaceSafety({ prisma, env, root, temporary, output, options, startApi }) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, firefox, webkit, expect } = await import('playwright/test')
  const { interfaceFixtures } = await import('./fixtures.ts')
  const { processReportExport } = await import('../../src/server/schedule/reports/export-jobs.ts')
  const socket = netServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
  const origin = 'http://127.0.0.1:' + port
  env.APP_ORIGIN = origin; env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi(), apiPort = Number(new URL(api).port)
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, plugins: [react(), devApiProxy(apiPort)], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  const firefoxHome = path.join(temporary, 'firefox-app-data'); await mkdir(firefoxHome, { recursive: true })
  const launch = {
    chrome: () => chromium.launch({ executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true }),
    firefox: () => firefox.launch({ headless: true, env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }),
    webkit: () => webkit.launch({ headless: true }),
  }
  const result = { status: 'running', checks: [], errors: [], screenshots: [] }
  const save = () => writeFile(path.join(output, 'workspace-progress.json'), JSON.stringify(result, null, 2))
  try {
    for (const name of (options.browsers ?? 'chrome').split(',')) {
      const browser = await launch[name]()
      try {
        for (const viewport of (options.viewports ?? 'desktop,mobile').split(',')) {
          const fixture = await interfaceFixtures('-' + name + '-' + viewport)
          const points = await prisma.organizationLocation.findMany({ where: { organizationId: fixture.org.id }, orderBy: { createdAt: 'asc' } })
          const base = '/app/organizations/' + fixture.org.id, location = '?location=' + fixture.org.locationId
          const context = await browser.newContext({ viewport: viewport === 'mobile' ? { width: 320, height: 740 } : viewport === 'zoom-200' ? { width: 720, height: 500 } : { width: 1440, height: 1000 }, deviceScaleFactor: viewport === 'zoom-200' ? 2 : 1, reducedMotion: 'reduce', locale: 'ru-RU' })
          await context.addInitScript(theme => { localStorage.setItem('staffly-cookie-consent', 'necessary'); localStorage.setItem('staffly.theme', theme) }, options.theme ?? 'light')
          const token = randomUUID() + randomUUID()
          await prisma.authSession.create({ data: { userId: fixture.owner.id, refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 4 * 3600000), absoluteExpiresAt: new Date(Date.now() + 4 * 3600000) } })
          await context.addCookies([{ name: 'staffly_refresh', value: token, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }])
          const page = await context.newPage()
          page.on('pageerror', error => result.errors.push({ browser: name, viewport, message: error.message }))
          const check = async (label, run) => {
            if (options.checks && !options.checks.split(',').some(value => label.includes(value))) return
            try { await run(); result.checks.push({ browser: name, viewport, label, status: 'passed' }); await save() }
            catch (error) {
              const file = name + '-' + viewport + '-failure.png'
              await page.screenshot({ path: path.join(output, file), fullPage: true }).catch(() => {})
              result.screenshots.push(file); result.checks.push({ browser: name, viewport, label, status: 'failed', error: error.message }); await save(); throw new Error(label + ': ' + error.message.slice(0,1200))
            }
          }
          const dialog = () => page.getByRole('dialog', { name: 'Новое событие', exact: true })
          const leave = () => page.getByRole('dialog', { name: 'Есть несохранённые изменения', exact: true })
          const openEvent = async () => {
            await page.getByRole('button', { name: 'Создать событие', exact: true }).first().click()
            await expect(dialog()).toBeVisible()
          }
          const cancel = async () => {
            await dialog().getByRole('button', { name: 'Закрыть', exact: true }).first().click()
            await expect(leave()).toBeVisible()
            await leave().getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
            await expect(dialog()).toBeHidden()
          }
          try {
            await page.goto(origin + base + '/events' + location)
            await check('modal close protection and draft restore after reload', async () => {
              await openEvent()
              await dialog().getByRole('textbox', { name: /^Название/ }).fill('Несохранённый текст ' + name)
              await dialog().getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await expect(leave()).toBeVisible()
              await page.keyboard.press('Tab')
              assert.equal(await leave().evaluate(node => node.contains(document.activeElement)), true, 'Confirmation traps keyboard focus')
              await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
              await expect(dialog().getByRole('textbox', { name: /^Название/ })).toHaveValue('Несохранённый текст ' + name)
              await dialog().getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await leave().getByRole('button', { name: 'Сохранить черновик и выйти' }).click()
              await expect(dialog()).toBeHidden()
              await page.reload(); await openEvent()
              await dialog().getByRole('button', { name: 'Восстановить', exact: true }).click()
              await expect(dialog().getByRole('textbox', { name: /^Название/ })).toHaveValue('Несохранённый текст ' + name)
              const shot = name + '-' + viewport + '-event-draft.png'
              await page.screenshot({ path: path.join(output, shot), fullPage: true }); result.screenshots.push(shot)
              let unloadSeen = false
              const native = async event => { unloadSeen = event.type() === 'beforeunload'; await event.accept() }
              page.once('dialog', native)
              await page.reload()
              page.off('dialog', native)
              if (name === 'chrome') assert.equal(unloadSeen, true, 'Native reload warning must appear after an edit')
              await openEvent(); await dialog().getByRole('button', { name: 'Восстановить', exact: true }).click()
              await expect(dialog().getByRole('textbox', { name: /^Название/ })).toHaveValue('Несохранённый текст ' + name)
              await cancel()
              await openEvent()
              await dialog().getByRole('textbox', { name: /^Название/ }).fill('Временный ввод')
              await expect(dialog()).toContainText('Черновик сохранён в этой вкладке')
              await dialog().getByRole('textbox', { name: /^Название/ }).fill('')
              await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('event-v1:')).length)).toBe(0)
              await dialog().getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await expect(dialog()).toBeHidden()
            })
            await check('network error retains event fields and support reference', async () => {
              await openEvent()
              const title = 'Сетевой повтор ' + randomUUID()
              await dialog().getByRole('textbox', { name: /^Название/ }).fill(title)
              const errorId = randomUUID()
              await page.route('**/api/organizations/*/events*', route => route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Тестовая ошибка', errorId }) }) : route.continue())
              await dialog().locator('form button.app-primary').last().click()
              await expect(dialog()).toContainText(errorId)
              await page.unrouteAll({ behavior: 'wait' })
              await expect(dialog().getByRole('textbox', { name: /^Название/ })).toHaveValue(title)
              await dialog().locator('form button.app-primary').last().click()
              await expect(dialog()).toBeHidden({ timeout: 20000 })
              assert.equal(await prisma.organizationEvent.count({ where: { organizationId: fixture.org.id, title } }), 1)
              const detail = page.getByRole('dialog', { name: title, exact: true })
              await expect(detail).toBeVisible()
              await detail.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await expect(page.getByRole('dialog')).toHaveCount(0)
            })
            await check('constructor protects sidebar navigation and browser Back', async () => {
              await page.getByRole('link', { name: 'Настройки', exact: true }).click()
              await page.getByRole('button', { name: 'Типы заявок', exact: true }).click()
              await page.getByRole('button', { name: '+ Создать тип', exact: true }).click()
              const builder = page.getByRole('dialog', { name: 'Новый тип заявки', exact: true })
              await builder.getByRole('textbox', { name: 'Название типа', exact: true }).fill('Черновик конструктора')
              await builder.getByRole('button', { name: '+ Добавить вопрос', exact: true }).click()
              await builder.getByRole('textbox', { name: 'Название вопроса', exact: true }).fill('')
              await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); if (!event.defaultPrevented) throw Error('Reload was not protected') })
              await builder.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await leave().getByRole('button', { name: 'Сохранить черновик и выйти' }).click()
              await expect(builder).toBeHidden()
              await page.getByRole('button', { name: '+ Создать тип', exact: true }).click()
              await builder.getByRole('button', { name: 'Восстановить', exact: true }).click()
              await expect(builder.getByRole('textbox', { name: 'Название вопроса', exact: true })).toHaveValue('')
              await page.getByRole('link', { name: 'События', exact: true }).evaluate(element => element.click())
              await expect(leave()).toBeVisible()
              await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
              await expect(builder.getByRole('textbox', { name: 'Название типа', exact: true })).toHaveValue('Черновик конструктора')
              await page.goBack({ waitUntil: 'commit', timeout: 3000 }).catch(() => {})
              await expect(leave()).toBeVisible()
              await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
              await builder.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await leave().getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
              await expect(builder).toBeHidden()
              const row = page.locator('.request-type-row').first()
              await row.getByRole('button', { name: 'Отключить подачу', exact: true }).click()
              await expect(row.getByRole('button', { name: 'Включить подачу', exact: true })).toBeEnabled()
              await row.getByRole('button', { name: 'Включить подачу', exact: true }).click()
              await expect(row.getByRole('button', { name: 'Отключить подачу', exact: true })).toBeEnabled()
            })
            await check('module filters survive navigation and reload without leaking into documents', async () => {
              await page.getByRole('link', { name: 'События', exact: true }).click()
              await page.getByRole('button', { name: 'Прошедшие', exact: true }).click()
              await page.getByRole('combobox', { name: 'Точка событий' }).click()
              await page.getByRole('option', { name: 'Вторая точка', exact: true }).click()
              await page.getByRole('textbox', { name: 'Поиск событий', exact: true }).fill('Сохранённый фильтр')
              await expect(page).toHaveURL(/search=/)
              await page.getByRole('link', { name: /^Документы/ }).click()
              await expect(page.getByLabel('Область текущего списка')).toContainText('Все доступные точки')
              await page.getByRole('link', { name: 'События', exact: true }).click()
              await expect(page.getByRole('textbox', { name: 'Поиск событий', exact: true })).toHaveValue('Сохранённый фильтр')
              await expect(page.getByLabel('Область текущего списка')).toContainText('Вторая точка')
              await page.reload()
              await expect(page.getByRole('textbox', { name: 'Поиск событий', exact: true })).toHaveValue('Сохранённый фильтр')
              assert.equal(new URL(page.url()).searchParams.get('pointId'), points[1].id)
              assert.equal(new URL(page.url()).searchParams.get('tab'), 'past')
              const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
              assert.equal(overflow, false, 'Workspace overflow')
            })
            await check('export resumes the same job, reaches ready and downloads', async () => {
              await page.goto(origin + base + '/schedule/statistics' + location)
              await page.getByRole('button', { name: /Выгрузка Excel|Выгрузить Excel|Выгрузить|Скачать Excel|Экспорт/ }).first().click()
              const report = page.getByRole('dialog', { name: 'Выгрузка Excel', exact: true })
              await expect(report.getByRole('button', { name: 'Подготовить .xlsx', exact: true })).toBeEnabled({ timeout: 20000 })
              const before = await prisma.reportExport.count()
              await report.getByRole('button', { name: 'Подготовить .xlsx', exact: true }).click()
              await expect(report.getByLabel('Состояние операции')).toContainText('Ожидает в очереди')
              const job = await prisma.reportExport.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
              await report.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
              await expect(report).toBeHidden()
              await page.getByRole('button', { name: /Выгрузка Excel|Выгрузить Excel|Выгрузить|Скачать Excel|Экспорт/ }).first().click()
              await expect(report.getByLabel('Состояние операции')).toContainText(job.id)
              assert.equal(await prisma.reportExport.count(), before + 1)
              for (let attempt = 0; attempt < 4; attempt++) {
                await processReportExport()
                if ((await prisma.reportExport.findUniqueOrThrow({ where: { id: job.id } })).status === 'READY') break
              }
              await expect(report.getByRole('button', { name: 'Скачать файл', exact: true })).toBeVisible({ timeout: 20000 })
              const download = page.waitForEvent('download')
              await report.getByRole('button', { name: 'Скачать файл', exact: true }).click()
              assert.match((await download).suggestedFilename(), /^Staffly_.*\.xlsx$/)
              await expect(report.getByLabel('Состояние операции')).toContainText('Файл передан браузеру')
              const snapshot = name + '-' + viewport + '-export-completed.png'
              await page.screenshot({ path: path.join(output, snapshot), fullPage: true }); result.screenshots.push(snapshot)
              let lostId
              await page.route('**/statistics/reports/export*', async route => {
                if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname.endsWith('/export') === false) { await route.continue(); return }
                const response = await route.fetch(); lostId = (await response.json()).job.id; await route.abort('failed')
              }, { times: 1 })
              await report.getByRole('button', { name: 'Подготовить .xlsx', exact: true }).click()
              await expect(report.getByLabel('Состояние операции')).toContainText('Проверка приостановлена')
              await report.getByRole('button', { name: 'Продолжить проверку', exact: true }).click()
              await expect(report.getByLabel('Состояние операции')).toContainText(lostId)
              assert.equal(await prisma.reportExport.count(), before + 2, 'Lost response must not enqueue twice')
              const budget = await prisma.organizationResourceBudget.findUniqueOrThrow({ where: { organizationId: fixture.org.id } })
              try {
                await prisma.organizationResourceBudget.update({ where: { organizationId: fixture.org.id }, data: { storageLimitBytes: budget.storageBytes + 1n } })
                await processReportExport()
                await expect(report.getByLabel('Состояние операции')).toContainText('Код для поддержки', { timeout: 20000 })
                await expect(report.getByLabel('Состояние операции')).toContainText(lostId)
                assert.equal(await prisma.securityEvent.count({ where: { resourceId: lostId, outcome: 'FAILED' } }), 1)
              } finally { await prisma.organizationResourceBudget.update({ where: { organizationId: fixture.org.id }, data: { storageLimitBytes: budget.storageLimitBytes } }) }
              await report.getByRole('button', { name: 'Создать повторно', exact: true }).click()
              await expect(report.getByLabel('Состояние операции')).toContainText('Ожидает в очереди')
              assert.equal(await prisma.reportExport.count(), before + 3, 'An explicit retry starts a new operation')
              await processReportExport()
              await expect(report.getByRole('button', { name: 'Скачать файл', exact: true })).toBeVisible({ timeout: 20000 })

              await report.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
            })
            await check('blocked browser storage keeps the form open and never claims a saved draft', async () => {
              await page.goto(origin + base + '/events' + location)
              await page.evaluate(() => {
                const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem
                window.__restoreSafetyStorage = () => { Storage.prototype.getItem = get; Storage.prototype.setItem = set; Storage.prototype.removeItem = remove }
                Storage.prototype.getItem = function(key) { if (this === sessionStorage) throw new DOMException('Blocked', 'SecurityError'); return get.call(this,key) }
                Storage.prototype.setItem = function(key,value) { if (this === sessionStorage) throw new DOMException('Blocked', 'QuotaExceededError'); return set.call(this,key,value) }
                Storage.prototype.removeItem = function(key) { if (this === sessionStorage) throw new DOMException('Blocked', 'SecurityError'); return remove.call(this,key) }
              })
              try {
                await openEvent()
                await dialog().getByRole('textbox', { name: /^Название/ }).fill('Память браузера недоступна')
                await expect(dialog()).toContainText('Черновик не сохраняется в браузере')
                await dialog().getByRole('button', { name: 'Закрыть', exact: true }).first().click()
                await leave().getByRole('button', { name: 'Сохранить черновик и выйти' }).click()
                await expect(leave()).toContainText('Не удалось сохранить черновик')
                await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
                await expect(dialog().getByRole('textbox', { name: /^Название/ })).toHaveValue('Память браузера недоступна')
                await cancel()
              } finally { await page.evaluate(() => { window.__restoreSafetyStorage?.(); delete window.__restoreSafetyStorage }) }
            })
            await check('settings preserve profile edits, protect passwords and clear private state on logout', async () => {
              await page.goto(origin + '/app/settings')
              await page.getByRole('button', { name: 'Редактировать', exact: true }).click()
              await page.getByRole('textbox', { name: 'Имя', exact: true }).fill('Несохранённое')
              await page.getByRole('button', { name: 'Безопасность', exact: true }).click()
              await expect(leave()).toBeVisible()
              await expect(leave().getByRole('button', { name: 'Сохранить черновик и выйти' })).toHaveCount(0)
              await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
              await expect(page.getByRole('textbox', { name: 'Имя', exact: true })).toHaveValue('Несохранённое')
              await page.getByRole('button', { name: 'Отмена', exact: true }).click()
              await leave().getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
              await expect(page.getByRole('button', { name: 'Редактировать', exact: true })).toBeEnabled()
              await page.getByRole('button', { name: 'Безопасность', exact: true }).click()
              const secret = 'Local-only-password-123!'
              await page.getByLabel('Текущий пароль', { exact: true }).fill(secret)
              await page.getByRole('button', { name: 'Профиль', exact: true }).click()
              await expect(leave()).toBeVisible()
              assert.equal(await page.evaluate(text => [JSON.stringify(sessionStorage), JSON.stringify(localStorage)].some(value => value.includes(text)), secret), false)
              await leave().getByRole('button', { name: 'Продолжить редактирование' }).click()
              await expect(page.getByLabel('Текущий пароль', { exact: true })).toHaveValue(secret)
              await page.getByRole('button', { name: 'Профиль', exact: true }).click()
              await leave().getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
              await page.getByRole('button', { name: 'Безопасность', exact: true }).click()
              await expect(page.getByLabel('Текущий пароль', { exact: true })).toHaveValue('')
              await page.getByRole('button', { name: 'Выйти', exact: true }).click()
              await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => ['staffly:form-draft:', 'staffly:module-filters:', 'staffly:module-route:', 'staffly:report-job:'].some(prefix => key.startsWith(prefix))).length)).toBe(0)
            })
          } finally { await context.close() }
        }
      } finally { await browser.close() }
    }
    assert.equal(result.errors.length, 0, 'Browser runtime errors')
    result.status = 'passed'; await save(); return result
  } finally {
    await server.close()
    if (process.platform === 'darwin') await new Promise(resolve => { const child = spawn('/bin/chmod', ['-RN', firefoxHome], { stdio: 'ignore' }); child.once('error', resolve); child.once('exit', resolve) })
  }
}
