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
  } finally { page.off('request', record); await page.evaluate(() => localStorage.removeItem('staffly.interface-cookie-check')).catch(() => {}) }
}
