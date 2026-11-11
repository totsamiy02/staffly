import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { createServer as netServer } from 'node:net'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { checkNetworkFailures } from './network-failures.mjs'

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
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-cache'), plugins: [react(), devApiProxy(apiPort)], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
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
            await expect(page.getByRole('button', { name: 'Открыть профиль', exact: true })).toBeVisible({ timeout: 20000 })
            await checkNetworkFailures({ browser, page, context, origin, base, location, fixture, prisma, check, expect, result, output, name, viewport })
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
            await check('system request folder shares library navigation and includes custom workflow attachments', async () => {
              const { createRequestType } = await import('../../src/server/requests/type-service.ts')
              const { createRequest, submitRequest } = await import('../../src/server/requests/request-submission.ts')
              const { addRequestAttachment } = await import('../../src/server/requests/attachment-service.ts')
              const { saveFolder } = await import('../../src/server/documents/service.ts')
              const owner = fixture.owner.id, org = fixture.org.id
              const custom = await createRequestType(owner, org, { name: 'Пользовательская заявка с файлом', dateMode: 'NONE', requiresComment: false, allowsAttachments: true,
                definition: { fields: [{ key: 'proof', label: 'Подтверждение', kind: 'FILE', required: true }] } })
              const builtin = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org, systemCode: 'OTHER' } })
              const names = ['custom-proof.pdf', 'builtin-proof.pdf'], ids = []
              for (const [index, type] of [custom, builtin].entries()) {
                const request = await createRequest(owner, org, { requestTypeId: type.id, draft: true, comment: 'Проверка вложения' })
                await addRequestAttachment(owner, org, request.id, Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf', names[index])
                await submitRequest(owner, org, request.id); ids.push(request.id)
              }
              const folder = await saveFolder(owner, org, undefined, { name: 'Навигация папок', parentId: null, pointId: fixture.org.locationId, visibility: 'ORGANIZATION' })
              const child = await saveFolder(owner, org, undefined, { name: 'Вложенная папка', parentId: folder.id, pointId: fixture.org.locationId, visibility: 'ORGANIZATION' })
              await page.goto(origin + base + '/documents' + location)
              const breadcrumbs = page.getByRole('navigation', { name: 'Расположение папки' })
              await page.getByRole('button', { name: /^Навигация папок/ }).click()
              let releaseFolder
              const folderResponse = new Promise(resolve => { releaseFolder = resolve })
              await page.route('**/api/organizations/*/documents?**', async route => {
                if (new URL(route.request().url()).searchParams.get('folderId') === child.id) await folderResponse
                await route.continue()
              })
              try {
                await page.getByRole('button', { name: /^Вложенная папка/ }).click()
                await expect(page, 'Opening the child folder').toHaveURL(new RegExp('folder=' + child.id))
                await expect(breadcrumbs.getByRole('button', { name: 'На уровень выше', exact: true })).toBeDisabled()
              } finally { releaseFolder() }
              await breadcrumbs.getByRole('button', { name: 'На уровень выше', exact: true }).click()
              await expect(page).toHaveURL(new RegExp('folder=' + folder.id))
              await breadcrumbs.getByRole('button', { name: 'Библиотека', exact: true }).click()
              await page.getByRole('combobox', { name: 'Сортировка', exact: true }).click()
              await page.getByRole('option', { name: 'Сначала новые', exact: true }).click()
              const rootQuery = new URL(page.url()).searchParams
              const system = page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' })
              await expect(system).toContainText('Системная')
              await expect(system.getByRole('button')).toHaveCount(1)
              await system.getByRole('button').click()
              await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible()
              await expect(page.getByRole('navigation', { name: 'Разделы документов' })).toBeVisible()
              await expect(breadcrumbs.getByRole('button', { name: 'Вложения заявок', exact: true })).toHaveAttribute('aria-current', 'page')
              await expect(page.locator('.request-files-description')).toHaveText('Вложения из доступных вам заявок.')
              await expect(page.getByLabel('Область текущего списка')).toHaveCount(0)
              await page.getByRole('button', { name: 'О системной папке', exact: true }).focus()
              await expect(page.getByRole('tooltip')).toContainText('Её нельзя удалить или переименовать.')
              await page.keyboard.press('Escape')
              await expect(page.getByRole('tooltip')).toHaveCount(0)
              await expect(page.getByRole('button', { name: 'Создать папку', exact: true })).toHaveCount(0)
              await expect(page.getByRole('button', { name: 'Загрузить документ', exact: true })).toHaveCount(0)
              for (const fileName of names) await expect(page.locator('.request-file-row').filter({ hasText: fileName })).toBeVisible()
              const ownFile = page.locator('.request-file-row').filter({ hasText: names[0] })
              const download = page.waitForEvent('download')
              await ownFile.getByRole('button', { name: 'Скачать', exact: true }).click()
              assert.equal((await download).suggestedFilename(), names[0])
              await page.getByRole('searchbox', { name: 'Найти вложение заявки', exact: true }).fill('custom-proof')
              await expect(page.locator('.request-file-row')).toHaveCount(1)
              await page.reload()
              await expect(page.getByRole('searchbox', { name: 'Найти вложение заявки', exact: true })).toHaveValue('custom-proof')
              await page.locator('.request-file-row').getByRole('link', { name: custom.name, exact: true }).click()
              await expect(page).toHaveURL(new RegExp('request=' + ids[0]))
              await page.goBack()
              await expect(page.getByRole('searchbox', { name: 'Найти вложение заявки', exact: true })).toHaveValue('custom-proof')
              await expect(page.locator('.request-file-row')).toHaveCount(1)
              assert.equal(await prisma.documentFolder.count({ where: { organizationId: org, name: 'Вложения заявок' } }), 0, 'The system folder must never create a mutable duplicate')
              const screenshot = name + '-' + viewport + '-request-folder.png'
              await page.locator('.request-files-page').screenshot({ path: path.join(output, screenshot) }); result.screenshots.push(screenshot)
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
              await page.locator('.request-file-row').getByRole('button', { name: 'Удалить', exact: true }).click()
              const removal = page.getByRole('dialog', { name: 'Удалить вложение?', exact: true })
              await expect(removal.getByRole('button', { name: 'Удалить вложение', exact: true })).toBeDisabled()
              await removal.getByRole('textbox', { name: 'Для подтверждения введите название', exact: true }).fill(names[0])
              const confirmShot = name + '-' + viewport + '-attachment-confirmation.png'
              await removal.screenshot({ path: path.join(output, confirmShot) }); result.screenshots.push(confirmShot)
              await removal.getByRole('button', { name: 'Удалить вложение', exact: true }).click()
              await expect(removal).toBeHidden()
              await expect(page.locator('.request-file-row')).toHaveCount(0)
              assert.equal(await prisma.requestAttachment.count({ where: { requestId: ids[0] } }), 0)
              const filesUrl = page.url()
              await page.goto(origin + base + '/requests' + location + '&tab=mine&request=' + ids[0])
              await expect(page.locator('.request-removed-attachments')).toContainText(names[0])
              await expect(page.locator('.request-removed-attachments')).toContainText('Удалено')
              await page.goto(origin + base + '/requests' + location + '&tab=mine&request=' + ids[1])
              await page.locator('.request-attachments').getByRole('button', { name: 'Удалить', exact: true }).click()
              const sourceRemoval = page.getByRole('dialog', { name: 'Удалить вложение?', exact: true })
              await expect(sourceRemoval.getByRole('button', { name: 'Удалить вложение', exact: true })).toBeDisabled()
              await sourceRemoval.getByRole('textbox', { name: 'Для подтверждения введите название', exact: true }).fill(names[1])
              await sourceRemoval.getByRole('button', { name: 'Удалить вложение', exact: true }).click()
              await expect(sourceRemoval).toBeHidden()
              await expect(page.locator('.request-removed-attachments')).toContainText(names[1])
              assert.equal(await prisma.requestAttachment.count({ where: { requestId: ids[1] } }), 0)
              await page.goto(filesUrl)
              await breadcrumbs.getByRole('button', { name: 'На уровень выше', exact: true }).click()
              await expect(page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' })).toBeVisible()
              assert.equal(new URL(page.url()).searchParams.get('sort'), rootQuery.get('sort'))
              assert.equal(new URL(page.url()).searchParams.has('system'), false)
              await page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' }).getByRole('button').click()
              await breadcrumbs.getByRole('button', { name: 'Библиотека', exact: true }).click()
              await expect(page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' })).toBeVisible()
              await page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' }).getByRole('button').click()
              await page.goBack()
              await expect(page.locator('.document-system-folder').filter({ hasText: 'Вложения заявок' })).toBeVisible()
            })
            await check('unified library protects system folders, restores documents and shows only granted employee folders', async () => {
              const { saveFolder, uploadDocument } = await import('../../src/server/documents/service.ts')
              const owner = fixture.owner.id, org = fixture.org.id, recipient = fixture.people[0]
              const restricted = await saveFolder(owner, org, undefined, { name: 'Доступ сотруднику', parentId: null, pointId: fixture.org.locationId, visibility: 'SELECTED', audienceMemberIds: [recipient.id] })
              const document = await uploadDocument(owner, org, Buffer.from('Закрытый документ сотрудника'), 'text/plain', 'employee-only.txt', { displayName: 'Выданный документ', visibility: 'ORGANIZATION', folderId: restricted.id, pointId: fixture.org.locationId, inheritAccess: true })
              const empty = await saveFolder(owner, org, undefined, { name: 'Папка для удаления', parentId: null, pointId: fixture.org.locationId })
              await page.goto(origin + base + '/documents' + location)
              const systemGroup = page.getByRole('region', { name: 'Системные папки', exact: true })
              await expect(systemGroup).toBeVisible()
              await expect(systemGroup).toContainText('Документы сотрудников')
              await systemGroup.getByLabel('Действия с папкой Документы сотрудников', { exact: true }).click()
              await expect(page.getByRole('button', { name: 'Настроить доступ', exact: true })).toBeVisible()
              await expect(page.getByRole('button', { name: 'Удалить папку', exact: true })).toHaveCount(0)
              await page.getByRole('button', { name: 'Настроить доступ', exact: true }).click()
              const systemAccess = page.getByRole('dialog', { name: 'Доступ к системной папке', exact: true })
              await expect(systemAccess.getByRole('textbox', { name: 'Название', exact: true })).toBeDisabled()
              await systemAccess.getByRole('button', { name: 'Отмена', exact: true }).click()
              await expect(systemAccess).toBeHidden()
              await expect(page.getByRole('button', { name: 'Мои документы', exact: true })).toHaveCount(0)
              await expect(page.getByRole('button', { name: 'Документы сотрудников', exact: true })).toHaveCount(0)
              await page.getByLabel('Действия с папкой ' + empty.name, { exact: true }).click()
              await page.getByRole('button', { name: 'Удалить папку', exact: true }).click()
              const confirmation = page.getByRole('dialog', { name: 'Удалить папку?', exact: true })
              await expect(confirmation.getByRole('button', { name: 'Удалить папку', exact: true })).toBeDisabled()
              await confirmation.getByRole('textbox', { name: 'Для подтверждения введите название', exact: true }).fill('Другая папка')
              await expect(confirmation.getByRole('button', { name: 'Удалить папку', exact: true })).toBeDisabled()
              await confirmation.getByRole('textbox', { name: 'Для подтверждения введите название', exact: true }).fill(empty.name)
              const shot = name + '-' + viewport + '-folder-confirmation.png'
              await confirmation.screenshot({ path: path.join(output, shot) }); result.screenshots.push(shot)
              await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click()
              await expect(confirmation).toBeHidden()
              assert.ok(await prisma.documentFolder.findUnique({ where: { id: empty.id } }))
              await page.getByLabel('Действия: ' + fixture.document.displayName, { exact: true }).click()
              await page.getByRole('button', { name: 'Удалить документ', exact: true }).click()
              await page.getByRole('dialog', { name: 'Удалить документ?', exact: true }).getByRole('button', { name: 'Удалить документ', exact: true }).click()
              await expect(page.getByRole('dialog')).toHaveCount(0)
              await page.getByRole('button', { name: 'Журнал удалений', exact: true }).click()
              await page.getByLabel('Действия: ' + fixture.document.displayName, { exact: true }).click()
              await page.getByRole('button', { name: 'Восстановить документ', exact: true }).click()
              await expect.poll(async () => (await prisma.document.findUniqueOrThrow({ where: { id: fixture.document.id } })).deletedAt).toBeNull()
              await page.getByRole('button', { name: 'Вернуться в библиотеку', exact: true }).click()
              assert.equal(await page.locator('.document-list-columns').evaluate(node => {
                const folders = [...document.querySelectorAll('.document-list .document-folder-row')]
                return folders.every(folder => Boolean(folder.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
              }), true, 'File column labels must follow folders')
              await expect(page.getByLabel('Область текущего списка')).toHaveCount(0)
              const libraryShot = name + '-' + viewport + '-unified-library.png'
              await page.locator('.document-list').screenshot({ path: path.join(output, libraryShot) }); result.screenshots.push(libraryShot)

              for (const [person, granted] of [[recipient, true], [fixture.people[1], false]]) {
                const employeeContext = await browser.newContext({ viewport: viewport === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'ru-RU' })
                await employeeContext.addInitScript(() => localStorage.setItem('staffly-cookie-consent', 'necessary'))
                await prisma.user.update({ where: { id: person.userId }, data: { passwordHash: fixture.owner.passwordHash } })
                const refresh = randomUUID() + randomUUID()
                await prisma.authSession.create({ data: { userId: person.userId, refreshTokenHash: createHash('sha256').update(refresh).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } })
                await employeeContext.addCookies([{ name: 'staffly_refresh', value: refresh, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }])
                const employeePage = await employeeContext.newPage()
                employeePage.on('pageerror', error => result.errors.push({ browser: name, viewport, message: error.message }))
                try {
                  await employeePage.goto(origin + base + '/documents' + location)
                  const folderButton = employeePage.getByRole('button', { name: new RegExp('^' + restricted.name) })
                  if (granted) {
                    await folderButton.click()
                    await employeePage.getByRole('button', { name: new RegExp('^Выданный документ') }).click()
                    const viewer = employeePage.getByRole('dialog', { name: 'Выданный документ', exact: true })
                    const download = employeePage.waitForEvent('download')
                    await viewer.getByRole('button', { name: 'Скачать', exact: true }).click()
                    assert.equal((await download).suggestedFilename(), 'employee-only.txt')
                    await viewer.getByRole('button', { name: 'Закрыть', exact: true }).click()
                    await employeePage.getByRole('button', { name: 'Открыть профиль', exact: true }).click()
                    await expect(employeePage.getByRole('link', { name: /^Мои документы/ })).toHaveCount(0)
                    await saveFolder(owner, org, restricted.id, { name: restricted.name, parentId: null, pointId: fixture.org.locationId, visibility: 'SELECTED', audienceMemberIds: [] })
                    await employeePage.goto(origin + base + '/documents' + location + '&document=' + document.id)
                    await expect(employeePage.locator('.document-viewer')).toContainText(/не найден|недоступен/)
                    await expect(employeePage.locator('.document-viewer')).not.toContainText('Закрытый документ сотрудника')
                  } else await expect(folderButton).toHaveCount(0)
                } finally { await employeeContext.close() }
              }
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
