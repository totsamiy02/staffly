import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as netServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { interfaceRoutes } from './routes.mjs'
import { modalScenarios } from './modal-scenarios.mjs'
import { visualRegression } from './visual-regression.mjs'
import { publicScenarios } from './public-scenarios.mjs'

async function freePort() { const server = netServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }

async function pageGeometry(page) {
  return page.evaluate(() => {
    const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && !element.closest('[aria-hidden=true],[inert]') }
    const describe = element => ({ tag: element.tagName.toLowerCase(), classes: element.className?.toString().slice(0, 150), text: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 80), rect: JSON.parse(JSON.stringify(element.getBoundingClientRect())) })
    const width = document.documentElement.clientWidth
    const overflow = [...document.querySelectorAll('body *')].filter(element => {
      if (!visible(element)) return false
      const rect = element.getBoundingClientRect()
      if (rect.right <= width + 2 && rect.left >= -2) return false
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) return false
      return true
    }).slice(0, 12).map(describe)
    const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select,button[role=combobox]')].filter(visible).map(element => ({ ...describe(element), fontSize: getComputedStyle(element).fontSize, minHeight: getComputedStyle(element).minHeight })).filter(field => field.rect.height < 24 || field.rect.width < 40)
    const theme = document.querySelector('.auth-theme-control')?.getBoundingClientRect(), form = document.querySelector('.auth__panel')?.getBoundingClientRect()
    const themeOverlapsForm = !!(theme && form && theme.right > form.left && theme.left < form.right && theme.bottom > form.top && theme.top < form.bottom)
    return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, overflow, smallFields: fields, themeOverlapsForm, mainCount: document.querySelectorAll('main').length, h1Count: document.querySelectorAll('h1').length }
  })
}

async function settle(page) {
  await page.waitForFunction(() => document.querySelector('main, [role=main]') && !document.querySelector('.app-loading,.route-loading'), { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(180)
}

export async function runInterface({ prisma, env, root, temporary, output, options, startApi }) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, firefox, webkit } = await import('playwright')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const { interfaceFixtures } = await import('./fixtures.ts')
  const fixture = await interfaceFixtures()
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin
  const api = await startApi(), apiPort = Number(new URL(api).port)
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, plugins: [react(), devApiProxy(apiPort)], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  await writeFile(path.join(output, 'fixture.json'), JSON.stringify({ origin, organizationId: fixture.org.id, email: fixture.owner.email }), { mode: 0o600 })
  console.log(`Isolated interface server: ${origin}`)
  const routes = interfaceRoutes(fixture).filter(([name]) => !options.routes || options.routes.split(',').some(part => name.includes(part)))
  const presets = [ ['desktop', 1440, 1000, 1], ['tablet', 768, 900, 1], ['mobile', 320, 740, 1], ['zoom-200', 720, 500, 2] ].filter(([name]) => !options.viewports || options.viewports.split(',').includes(name))
  assert(routes.length && presets.length, 'No interface routes or viewports selected')
  const firefoxHome = path.join(temporary, 'firefox-app-data'); await mkdir(firefoxHome, { recursive: true, mode: 0o700 })
  const browsers = { chrome: () => chromium.launch({ executablePath: options.chrome ?? process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true }), firefox: () => firefox.launch({ headless: true, env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }), webkit: () => webkit.launch({ headless: true }) }
  const theme = options.theme ?? 'light'
  assert(['light', 'dark'].includes(theme), 'Unknown interface theme')
  const results = { formatVersion: 1, methodology: 'Real isolated API/PostgreSQL, synthetic long names, Chrome/Firefox/WebKit. zoom-200 uses equivalent CSS viewport (1440/2) and pixel ratio 2; native Safari zoom requires a separate check. axe WCAG 2/2.1/2.2 A/AA and best practices, geometry, real keyboard input, screenshots.', theme, browsers: {}, checks: [], visual: [], pages: [], errors: [], screenshots: [] }
  const save = () => writeFile(path.join(output, 'interface-progress.json'), JSON.stringify(results, null, 2))
  try {
    for (const name of (options.browsers ?? 'chrome,firefox,webkit').split(',')) {
      assert(browsers[name], `Unknown interface browser: ${name}`)
      let browser
      try { browser = await browsers[name]() } catch (error) { results.errors.push({ browser: name, error: error.message }); await save(); continue }
      results.browsers[name] = browser.version()
      console.log(`Interface browser: ${name} ${browser.version()}`)
      try {
        for (const [preset, width, height, deviceScaleFactor] of presets) {
          const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' })
          const anon = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' })
          for (const value of [context, anon]) await value.addInitScript(theme => {
            localStorage.setItem('staffly.theme', theme)
            if (location.hash === '#interface-cookies') localStorage.removeItem('staffly-cookie-consent')
            else if (!localStorage.getItem('staffly.interface-cookie-check')) localStorage.setItem('staffly-cookie-consent', 'necessary')
            if (['/verify-email', '/reset-password'].includes(location.pathname)) history.replaceState({ ...history.state, usr: { email: 'interface-pending@example.test' } }, '')
          }, theme)
          const raw = randomUUID() + randomUUID()
          await prisma.authSession.create({ data: { userId: fixture.owner.id, refreshTokenHash: createHash('sha256').update(raw).digest('hex'), idleExpiresAt: new Date(Date.now() + 4 * 3600000), absoluteExpiresAt: new Date(Date.now() + 4 * 3600000) } })
          await context.addCookies([{ name: 'staffly_refresh', value: raw, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }])
          const ownerPage = await context.newPage(), anonPage = await anon.newPage()
          for (const page of [ownerPage, anonPage]) {
            page.on('pageerror', error => results.errors.push({ browser: name, preset, route: new URL(page.url()).pathname, error: error.message }))
            page.on('response', response => { if (response.status() >= 500 && response.url().includes('/api/')) results.errors.push({ browser: name, preset, route: new URL(page.url()).pathname, status: response.status(), api: new URL(response.url()).pathname }) })
          }
          try {
            for (const [routeName, route, authenticated] of routes) {
              const page = authenticated ? ownerPage : anonPage
              const entry = { browser: name, preset, name: routeName, route: route.replaceAll(fixture.org.id, ':organization').replaceAll(fixture.draft.id, ':draft'), violations: [] }
              try {
                await page.goto(origin + route, { waitUntil: 'domcontentloaded' }); await settle(page)
                assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'The requested theme did not initialize')
                entry.geometry = await pageGeometry(page)
                await page.waitForFunction(() => !document.querySelector('[aria-modal=true] .app-spinner'))
                await page.waitForTimeout(220)
                const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
                entry.violations = audit.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary, html: n.html })) }))
                if (options.visual !== 'false') { const comparison = await visualRegression({ page, root, output, browser: name, version: browser.version(), preset, name: routeName, theme, update: options['update-visual'] === 'true' }); if (comparison) results.visual.push(comparison) }
                await page.keyboard.press('Tab')
                entry.focus = await page.evaluate(() => { const e = document.activeElement; return { tag: e?.tagName, name: e?.getAttribute('aria-label') || e?.textContent?.trim().slice(0, 60), positiveTabIndexes: document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length } })
                const shot = `${name}-${preset}-${routeName}.png`
                const tall = await page.evaluate(() => document.documentElement.scrollHeight * devicePixelRatio > 28000)
                await page.screenshot({ path: path.join(output, shot), fullPage: !tall, animations: 'disabled' }); results.screenshots.push(shot)
                if (tall) { entry.tiledScreenshot = true; for (const [part, fraction] of [['middle', .5], ['bottom', 1]]) { await page.evaluate(f => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), fraction); const tile = `${name}-${preset}-${routeName}-${part}.png`; await page.screenshot({ path: path.join(output, tile), animations: 'disabled' }); results.screenshots.push(tile) } await page.evaluate(() => window.scrollTo(0, 0)) }
                if (routeName === 'controls') await keyboardControls(page, results, name, preset)
              } catch (error) { entry.error = error.message; await page.screenshot({ path: path.join(output, `${name}-${preset}-${routeName}-failure.png`), fullPage: true }).catch(() => {}) }
              results.pages.push(entry)
              if (options.quiet !== 'true') console.log(JSON.stringify({ browser: name, preset, route: routeName, violations: entry.violations.map(v => v.id), overflow: entry.geometry?.scrollWidth > width + 2, error: entry.error?.slice(0, 200) }))
              await save()
            }
            const captureState = async (caseName, page, error) => {
              await page.waitForFunction(() => !document.querySelector('[aria-modal=true] .app-spinner'))
              await page.waitForTimeout(220)
              const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
              const entry = { browser: name, preset, name: caseName, route: 'dialog', error, geometry: await pageGeometry(page), violations: audit.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary, html: n.html })) })) }
              results.pages.push(entry); await page.screenshot({ path: path.join(output, `${name}-${preset}-${caseName}.png`), animations: 'disabled' }); await save()
              if (options.quiet !== 'true') console.log(JSON.stringify({ browser: name, preset, dialog: caseName, violations: entry.violations.map(v => v.id), error }))
            }
            if (routes.some(([route]) => route === 'auth' || route === 'home')) { try { await publicScenarios({ page: anonPage, origin, browser: name, preset, results, capture: captureState }) } catch (error) { results.errors.push({ browser: name, preset, scenario: 'public-keyboard', error: error.message }) } }
            if (options.modals === 'true') await modalScenarios({ page: ownerPage, origin, fixture, capture: captureState })
          } finally { await context.close(); await anon.close() }
        }
      } finally { await browser.close() }
    }
    results.passed = results.errors.length === 0 && results.checks.every(check => check.passed) && results.visual.every(check => check.passed) && results.pages.every(p => !p.error && !p.violations.length && p.geometry.scrollWidth <= p.geometry.viewport.width + 2 && !p.geometry.smallFields.length && !p.geometry.themeOverlapsForm && !p.focus?.positiveTabIndexes)
    console.log(JSON.stringify({ interface: results.passed ? 'PASS' : 'FAIL', states: results.pages.length, keyboardChecks: results.checks.length, visualComparisons: results.visual.length, errors: results.errors.length }))
    await save()
    if (options.hold === 'true') { const finish = path.join(output, 'finish-native-check'); console.log(`Keeping isolated server ${origin}; create ${finish} to finish.`); await new Promise(resolve => { const poll = setInterval(async () => { try { await readFile(finish); clearInterval(poll); resolve() } catch {} }, 300) }) }
    if (options.audit !== 'true') assert(results.passed, 'Interface regressions found; inspect interface-progress.json')
    return results
  } finally {
    await server.close()
    if (process.platform === 'darwin') {
      // macOS creates a deny-delete ACL on Library in this synthetic CF home.
      // Remove it only inside our own disposable app-data tree before runner cleanup.
      const child = spawn('/bin/chmod', ['-R', '-P', '-N', firefoxHome], { stdio: 'ignore' })
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
}

async function keyboardControls(page, results, browser, preset) {
  const checks = []
  await page.getByRole('button', { name: 'Открыть окно', exact: true }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Проверка фокуса', exact: true })
  await dialog.waitFor()
  checks.push(['dialog-initial-focus', await dialog.evaluate(e => e.contains(document.activeElement))])
  for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < 30; index++) { await page.keyboard.press(key); assert(await dialog.evaluate(e => e.contains(document.activeElement)), `${key} escaped modal: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300))}`) }
  const select = dialog.getByRole('combobox', { name: 'Обычный список', exact: true })
  await select.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter')
  checks.push(['select-keyboard-selection', (await select.textContent()).includes('Оченьдлинное')])
  const searchable = dialog.getByRole('combobox', { name: 'Поиск в списке', exact: true })
  await searchable.focus(); await page.keyboard.press('Enter')
  const search = page.locator('.staffly-select__options input')
  await search.fill('нет такого значения'); await page.getByText('Ничего не найдено', { exact: true }).waitFor()
  await search.fill('Другое'); await page.keyboard.press('Enter')
  checks.push(['search-select-keyboard', (await searchable.textContent()).includes('Другое') && await searchable.evaluate(e => e === document.activeElement)])
  const date = dialog.getByRole('button', { name: /Дата/ }).first()
  await date.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Escape')
  checks.push(['date-escape-restores-focus', await date.evaluate(e => e === document.activeElement)])
  const month = dialog.getByRole('button', { name: /^Период:/ })
  await month.focus(); await page.keyboard.press('Enter')
  const monthDialog = page.getByRole('dialog', { name: 'Выбор месяца и года', exact: true })
  await monthDialog.waitFor(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Escape')
  checks.push(['month-escape-restores-focus', await month.evaluate(e => e === document.activeElement)])
  const help = dialog.getByRole('button', { name: 'Помощь по полю', exact: true })
  await help.focus(); await page.getByRole('tooltip').waitFor(); await page.keyboard.press('Escape')
  checks.push(['help-escape-keeps-parent-dialog', await dialog.isVisible() && await help.evaluate(e => e === document.activeElement)])
  const nestedTrigger = dialog.getByRole('button', { name: 'Открыть вложенное окно', exact: true })
  await nestedTrigger.focus(); await page.keyboard.press('Enter')
  const nested = page.getByRole('dialog', { name: 'Вложенное окно', exact: true })
  await nested.waitFor()
  for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert(await nested.evaluate(e => e.contains(document.activeElement)), 'Tab escaped nested dialog') }
  await page.keyboard.press('Escape'); await nested.waitFor({ state: 'hidden' })
  checks.push(['nested-dialog-return-focus', await nestedTrigger.evaluate(e => e === document.activeElement && !e.closest('[inert]'))])
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  checks.push(['dialog-return-focus', await page.getByRole('button', { name: 'Открыть окно', exact: true }).evaluate(e => e === document.activeElement)])
  for (const [name, passed] of checks) { results.checks.push({ browser, preset, name, passed }); assert(passed, name) }
}
