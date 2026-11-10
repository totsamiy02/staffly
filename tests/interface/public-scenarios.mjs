import assert from 'node:assert/strict'

export async function publicScenarios({ page, origin, browser, preset, results, capture }) {
  const check = (name, passed) => { results.checks.push({ browser, preset, name, passed }); assert(passed, name) }
  const posts = []
  const record = request => { if (request.method() === 'POST' && /\/api\/auth\/(login|register|forgot-password)$/.test(request.url())) posts.push(request.url()) }
  page.on('request', record)
  try {
    await page.goto(origin + '/auth')
    const email = page.getByRole('textbox', { name: 'Электронная почта', exact: true })
    const password = page.getByLabel('Пароль', { exact: true })
    await page.getByRole('button', { name: 'Войти', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.locator('input[name=email][aria-invalid=true]').waitFor()
    check('login-error-focus', await email.evaluate(e => e === document.activeElement && !!e.getAttribute('aria-describedby')))
    await capture('login-validation', page)
    await email.fill('incorrect-email'); await password.fill('test-only')
    await page.getByRole('button', { name: 'Войти', exact: true }).focus(); await page.keyboard.press('Enter')
    check('invalid-login-is-local', posts.length === 0 && await email.evaluate(e => e === document.activeElement))
    await page.getByRole('button', { name: 'Показать пароль', exact: true }).focus(); await page.keyboard.press('Enter')
    check('password-toggle-keyboard', await password.getAttribute('type') === 'text')
    await page.getByRole('button', { name: 'Скрыть пароль', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Забыли пароль?', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: 'Восстановление доступа', exact: true }).waitFor()
    check('route-focuses-main', await page.locator('main').evaluate(e => e === document.activeElement))
    await page.getByRole('textbox', { name: 'Электронная почта', exact: true }).fill('invalid-email')
    await page.getByRole('button', { name: 'Отправить код', exact: true }).focus(); await page.keyboard.press('Enter')
    check('native-email-validation', posts.length === 0 && await page.locator('input[type=email]').evaluate(e => !e.validity.valid && e === document.activeElement))

    await page.evaluate(() => localStorage.setItem('staffly.interface-cookie-check', 'true'))
    await page.goto(origin + '/#interface-cookies')
    const cookie = page.getByRole('dialog', { name: 'Мы используем cookie', exact: true })
    await cookie.waitFor()
    for (const key of ['Tab', 'Shift+Tab']) for (let n = 0; n < 10; n++) { await page.keyboard.press(key); assert(await cookie.evaluate(e => e.contains(document.activeElement)), 'Cookie dialog lost keyboard focus') }
    await capture('cookie-dialog', page)
    await cookie.getByRole('link', { name: 'политике cookie', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.locator('main.legal-document').waitFor()
    check('policy-readable-before-consent', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => localStorage.getItem('staffly-cookie-consent') === null))
    await page.goto(origin + '/')
    await cookie.waitFor()
    await cookie.getByRole('button', { name: 'Только необходимые', exact: true }).focus(); await page.keyboard.press('Enter')
    await cookie.waitFor({ state: 'hidden' })
    check('cookie-choice-releases-page', await page.evaluate(() => localStorage.getItem('staffly-cookie-consent') === 'necessary' && !document.getElementById('root').inert))
    await page.locator('main:not(.route-loading):not(.app-loading)').waitFor()
    const broken = await page.locator('footer a').evaluateAll(links => links.filter(link => { const url = new URL(link.href); return url.origin === location.origin && url.pathname === '/' && url.hash && !document.getElementById(decodeURIComponent(url.hash.slice(1))) }).map(link => link.getAttribute('href')))
    check('footer-home-anchors', broken.length === 0)
    await publicNavigation({ page, origin, check, capture })
  } finally { page.off('request', record); await page.evaluate(() => localStorage.removeItem('staffly.interface-cookie-check')).catch(() => {}) }
}

async function publicNavigation({ page, origin, check, capture }) {
  let revision = 1
  const bodies = { home: '## О сервисе\n\nОпубликованная главная.', contacts: 'Связь с владельцем: [справочник](/guide).', 'legal:privacy': '## Новые условия\n\nПолитика опубликована.', 'legal:offer': '## Новые условия\n\nОферта опубликована.', 'guide:profile': '## Новая инструкция\n\n[Контакты](/contacts)', 'guide:navigation-check': '## Начало {#start}\n\n[Главная](/#benefits)' }
  const item = key => ({ key, kind: key.split(':')[0], title: `Публикация ${key} · ${revision}`, body: bodies[key], metadata: { category: 'account', audience: 'everyone', summary: `Описание ${key} · ${revision}` }, revision, effective_at: '2026-11-10T00:00:00Z', published_at: '2026-11-10T00:00:00Z' })
  const mock = async route => {
    const path = new URL(route.request().url()).pathname
    const key = decodeURIComponent(path.slice('/api/public/content/'.length))
    await route.fulfill({ json: path === '/api/public/content' ? { items: Object.keys(bodies).filter(k => k.startsWith('guide:')).map(item) } : bodies[key] ? item(key) : null })
  }
  await page.route('**/api/public/content**', mock)
  try {
    await page.goto(origin + '/#benefits')
    await page.reload()
    await page.getByRole('heading', { name: 'Публикация home · 1', exact: true }).waitFor()
    for (const id of ['about', 'benefits', 'pricing']) await page.locator('#' + id).waitFor({ state: 'attached' })
    check('published-home-keeps-footer-anchors', true)
    await page.locator('footer').getByRole('link', { name: 'Контакты', exact: true }).click()
    await page.getByRole('heading', { name: 'Публикация contacts · 1', exact: true }).waitFor()
    await page.waitForFunction(() => document.title === 'Публикация contacts · 1 — Staffly')
    check('published-contacts-metadata', await page.locator('meta[name="description"]').getAttribute('content') === 'Описание contacts · 1')
    await capture('published-contacts', page)
    for (const [path, ids] of [['/privacy-policy', ['cookies', 'contacts']], ['/offer', ['payment', 'details']]]) {
      for (const id of ids) {
        await page.goto(origin + path + '#' + id)
        await page.getByText('Новые условия', { exact: true }).waitFor()
        await page.locator('#' + id).waitFor({ state: 'attached' })
      }
    }
    check('published-documents-keep-legacy-anchors', true)
    await page.goto(origin + '/guide/profile')
    await page.getByRole('heading', { name: 'Публикация guide:profile · 1', exact: true }).waitFor()
    await page.getByRole('link', { name: 'Контакты', exact: true }).click()
    await page.getByRole('heading', { name: 'Публикация contacts · 1', exact: true }).waitFor()
    check('published-article-links-to-contacts', new URL(page.url()).pathname === '/contacts')
    await page.goto(origin + '/guide/navigation-check#start')
    await page.locator('#start').waitFor()
    await page.waitForFunction(() => document.title === 'Публикация guide:navigation-check · 1 — Staffly')
    revision = 2
    await page.reload()
    await page.getByRole('heading', { name: 'Публикация guide:navigation-check · 2', exact: true }).waitFor()
    await page.waitForFunction(() => document.title === 'Публикация guide:navigation-check · 2 — Staffly')
    check('publication-update-keeps-direct-url-and-metadata', await page.locator('#start').count() === 1 && (await page.locator('link[rel="canonical"]').getAttribute('href')).endsWith('/guide/navigation-check'))
    await page.getByRole('link', { name: 'Главная', exact: true }).click()
    await page.getByRole('heading', { name: 'Публикация home · 2', exact: true }).waitFor()
    await page.locator('#benefits').waitFor({ state: 'attached' })
    await page.locator('footer').getByRole('link', { name: 'Справочник', exact: true }).click()
    await page.getByRole('link', { name: /Начало работы/ }).first().click()
    await page.getByRole('heading', { name: 'Публикация guide:navigation-check · 2', exact: true }).waitFor()
    check('public-navigation-after-publication-update', true)
  } finally { await page.unroute('**/api/public/content**', mock) }
}
