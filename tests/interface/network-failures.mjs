import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const technical = /Failed to fetch|Load failed|NetworkError|PrismaClient|Unexpected token|nginx:|private-internal-value/

export async function checkNetworkFailures({ browser, page, context, origin, base, location, fixture, prisma, check, expect, result, output, name, viewport }) {
  const apiBase = base.replace(/^\/app/, '')
  const screenshot = async (target, suffix) => {
    const file = `${name}-${viewport}-${suffix}.png`
    await target.screenshot({ path: path.join(output, file), fullPage: true }); result.screenshots.push(file)
  }
  const safeUi = async target => {
    assert.doesNotMatch(await target.locator('body').innerText(), technical)
    assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Error UI must fit a small screen')
  }
  await check('network failures: auth forms retain input, hide internals and recover', async () => {
    const anonymous = await browser.newContext({ viewport: page.viewportSize(), reducedMotion: 'reduce', locale: 'ru-RU' })
    const auth = await anonymous.newPage()
    auth.on('pageerror', error => result.errors.push({ browser: name, viewport, message: error.message }))
    const errorId = randomUUID(), email = 'network-check@example.test', password = 'Network-Test-Only-4729!'
    let mode = 'network', posts = 0
    await anonymous.addInitScript(() => localStorage.setItem('staffly-cookie-consent', 'necessary'))
    await auth.route('**/api/auth/**', route => {
      const endpoint = new URL(route.request().url()).pathname.split('/api/auth/')[1]
      if (endpoint === 'refresh') return route.fulfill({ status: 401, json: {} })
      if (endpoint === 'yandex/status') return route.fulfill({ json: { enabled: false } })
      if (endpoint === 'yandex/pending' && mode === 'success') return route.fulfill({ json: { mode: 'connect', email, firstName: 'Тест', canConfirmPassword: true, returnTo: '/app' } })
      posts++
      if (mode === 'network') return route.abort('failed')
      if (mode === 'gateway') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>nginx: private-internal-value</html>' })
      if (mode === 'invalid-json') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"partial":' })
      if (mode === 'invalid-auth') return route.fulfill({ json: {} })
      if (mode === 'server') return route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'PrismaClient: private-internal-value', errorId } })
      if (mode === 'validation') return route.fulfill({ status: 401, json: { message: 'Неверная почта или пароль.' } })
      return route.fulfill({ json: { message: 'Код отправлен.' } })
    })
    try {
      await auth.goto(origin + '/auth')
      await auth.getByLabel('Электронная почта', { exact: true }).fill(email)
      await auth.getByLabel('Пароль', { exact: true }).fill(password)
      await anonymous.setOffline(true)
      await auth.getByRole('button', { name: 'Войти', exact: true }).click()
      await expect(auth.getByRole('alert')).toContainText('подтверждение')
      await expect(auth.getByLabel('Пароль', { exact: true })).toHaveValue(password)
      await anonymous.setOffline(false)
      for (const failure of ['gateway', 'invalid-json', 'invalid-auth', 'server']) {
        mode = failure; const before = posts
        await auth.getByRole('button', { name: 'Войти', exact: true }).click()
        await expect(auth.getByRole('alert')).toContainText(failure === 'gateway' || failure === 'server' ? 'Сервис временно недоступен' : 'корректный ответ')
        assert.equal(posts, before + 1)
        await expect(auth.getByLabel('Электронная почта', { exact: true })).toHaveValue(email)
        await expect(auth.getByLabel('Пароль', { exact: true })).toHaveValue(password)
        await safeUi(auth)
      }
      await expect(auth.getByRole('alert')).toContainText(errorId)
      await auth.getByRole('button', { name: 'Скопировать код для поддержки' }).focus()
      await screenshot(auth, 'auth-server-error')
      mode = 'validation'
      await auth.getByRole('button', { name: 'Войти', exact: true }).click()
      await expect(auth.getByRole('alert')).toContainText('Неверная почта или пароль.')

      mode = 'network'
      await auth.getByRole('button', { name: 'Регистрация', exact: true }).click()
      await auth.getByRole('button', { name: 'Получить код', exact: true }).click()
      await expect(auth.getByRole('alert')).toContainText('подтверждение')
      await expect(auth.getByLabel('Электронная почта', { exact: true })).toHaveValue(email)
      mode = 'success'
      await auth.getByRole('button', { name: 'Получить код', exact: true }).click()
      await expect(auth).toHaveURL(/\/verify-email$/)
      await expect(auth.getByRole('heading', { name: 'Завершите регистрацию', exact: true })).toBeVisible()
      assert.match(await auth.locator('body').innerText(), new RegExp(email))

      mode = 'network'
      for (const form of [
        { path: '/forgot-password', submit: 'Отправить код' },
        { path: '/verify-email', code: 'Код подтверждения', password: 'Придумайте пароль', submit: 'Создать аккаунт', consents: true },
        { path: '/reset-password', code: 'Код из письма', password: 'Новый пароль', submit: 'Сохранить пароль' },
      ]) {
        await auth.goto(origin + form.path)
        await auth.getByLabel('Электронная почта', { exact: true }).fill(email)
        if (form.code) {
          await auth.getByLabel(form.code, { exact: true }).fill('123456')
          await auth.getByLabel(form.password, { exact: true }).fill(password)
          await auth.getByLabel('Повторите пароль', { exact: true }).fill(password)
        }
        if (form.consents) for (const checkbox of await auth.getByRole('checkbox').all()) await checkbox.check()
        const before = posts
        await auth.getByRole('button', { name: form.submit, exact: true }).click()
        await expect(auth.getByRole('alert')).toContainText('подтверждение')
        await expect(auth.getByRole('button', { name: form.submit, exact: true })).toBeEnabled()
        assert.equal(posts, before + 1)
        await expect(auth.getByLabel('Электронная почта', { exact: true })).toHaveValue(email)
        if (form.code) await expect(auth.getByLabel(form.code, { exact: true })).toHaveValue('123456')
        await safeUi(auth)
      }
      await auth.goto(origin + '/auth/yandex')
      await expect(auth.getByRole('alert')).toContainText('Проверьте соединение')
      mode = 'success'
      await auth.getByRole('button', { name: 'Повторить', exact: true }).click()
      await auth.getByLabel('Пароль Staffly', { exact: true }).fill(password)
      mode = 'network'
      await auth.getByRole('button', { name: 'Подключить и войти', exact: true }).click()
      await expect(auth.getByRole('alert')).toContainText('подтверждение')
      await expect(auth.getByLabel('Пароль Staffly', { exact: true })).toHaveValue(password)
      await safeUi(auth)
      assert.equal(await auth.evaluate(secret => JSON.stringify([sessionStorage, localStorage]).includes(secret), password), false)
    } finally { await anonymous.close() }
  })

  await check('network failures: document list retries and support codes copy safely', async () => {
    const errorId = randomUUID()
    await page.route('**/api' + apiBase + '/documents?*', route => route.fulfill({ status: 500, json: { errorId, code: 'INTERNAL_ERROR', message: 'PrismaClient: private-internal-value' } }))
    try {
      await page.goto(origin + base + '/documents' + location)
      const failure = page.getByRole('alert').filter({ hasText: errorId })
      await expect(failure).toBeVisible({ timeout: 15000 })
      await expect(failure).toContainText('Сервис временно недоступен')
      await expect(page.getByText('Папка недоступна или удалена.', { exact: false })).toHaveCount(0)
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied') } } }))
      await failure.getByRole('button', { name: 'Скопировать код для поддержки' }).click()
      await expect(failure).toContainText('скопируйте вручную')
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), errorId)
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedSupport = value } } }))
      await failure.getByRole('button', { name: 'Скопировать код для поддержки' }).click()
      await expect(failure).toContainText('Скопировано')
      assert.equal(await page.evaluate(() => window.__copiedSupport), errorId)
      const messageBox = await failure.locator('.request-error-message').boundingBox()
      const retryBox = await failure.getByRole('button', { name: 'Повторить', exact: true }).boundingBox()
      assert.ok(messageBox && retryBox && retryBox.y >= messageBox.y + messageBox.height, 'Retry action must sit below the readable message, including at 320px')
      await safeUi(page); await screenshot(page, 'documents-server-error')
    } finally { await page.unroute('**/api' + apiBase + '/documents?*') }
    await page.getByRole('alert').filter({ hasText: errorId }).getByRole('button', { name: 'Повторить', exact: true }).click()
    await expect(page.locator('.document-row__name').filter({ hasText: fixture.document.displayName })).toBeVisible()
  })

  await check('network failures: file preview and download recover without technical messages', async () => {
    await page.goto(origin + base + '/documents' + location)
    const content = '**/api' + apiBase + '/documents/' + fixture.document.id + '/content?*'
    await page.route(content, route => route.abort('failed'))
    try {
      await page.locator('.document-row__name').filter({ hasText: fixture.document.displayName }).click()
      await expect(page.locator('.file-preview-state')).toContainText('Проверьте соединение')
      await page.getByRole('dialog').getByRole('button', { name: 'Скачать', exact: true }).click()
      await expect(page.locator('.document-viewer-error')).toContainText('подтверждение')
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Скачать', exact: true })).toBeEnabled()
      await safeUi(page); await screenshot(page, 'file-network-error')
    } finally { await page.unroute(content) }
    await page.locator('.file-preview-state').getByRole('button', { name: 'Повторить', exact: true }).click()
    await expect(page.locator('.file-preview-reader')).toContainText('Синтетический документ')
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click()
  })

  await check('network failures: document upload preserves the selected file and metadata', async () => {
    await page.goto(origin + base + '/documents' + location)
    await page.getByRole('button', { name: 'Загрузить документ', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Загрузить документ', exact: true })
    await dialog.locator('input[type=file]').setInputFiles({ name: 'network-failure.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic upload check') })
    await dialog.getByLabel('Название', { exact: true }).fill('Сохранённое название файла')
    const pattern = '**/api' + apiBase + '/documents?*'
    let uploads = 0
    await page.route(pattern, route => {
      if (route.request().method() !== 'PUT') return route.continue()
      uploads++; return route.abort('failed')
    })
    try {
      await dialog.locator('form button.app-primary').last().click()
      await expect(dialog.getByRole('alert')).toContainText('подтверждение')
      await expect(dialog.getByLabel('Название', { exact: true })).toHaveValue('Сохранённое название файла')
      await expect(dialog).toContainText('network-failure.txt')
      assert.equal(uploads, 1)
      await expect(dialog.locator('form button.app-primary').last()).toBeEnabled()
      await safeUi(page)
    } finally { await page.unroute(pattern) }
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await page.getByRole('dialog', { name: 'Есть несохранённые изменения', exact: true }).getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  await check('network failures: offline saves are not queued and failed logout keeps the session', async () => {
    await page.goto(origin + base + '/events' + location)
    await page.getByRole('button', { name: 'Создать событие', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Новое событие', exact: true }), title = 'Offline manual retry ' + randomUUID()
    await dialog.getByRole('textbox', { name: /^Название/ }).fill(title)
    const submit = dialog.locator('form button.app-primary').last()
    await expect(submit).toBeEnabled()
    try {
      await context.setOffline(true)
      await submit.click()
      await expect(dialog).toContainText('подтверждение')
      await expect(submit).toBeEnabled()
      await expect(dialog.getByRole('textbox', { name: /^Название/ })).toHaveValue(title)
    } finally { await context.setOffline(false) }
    // A paused TanStack mutation used to resume automatically on the online event.
    await assert.rejects(page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api' + apiBase + '/events', { timeout: 1000 }))
    assert.equal(await prisma.organizationEvent.count({ where: { organizationId: fixture.org.id, title } }), 0)
    await submit.click()
    await expect(dialog).toBeHidden({ timeout: 20000 })
    assert.equal(await prisma.organizationEvent.count({ where: { organizationId: fixture.org.id, title } }), 1)
    await page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: 'Закрыть', exact: true }).first().click()
    await page.route('**/api/auth/logout', route => route.abort('failed'))
    try {
      await page.getByRole('button', { name: 'Открыть профиль', exact: true }).click()
      await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click()
      await expect(page.getByRole('region', { name: 'Профиль пользователя' }).getByRole('alert')).toContainText('подтверждение')
      await expect(page.getByRole('button', { name: 'Открыть профиль', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Выйти из аккаунта', exact: true })).toBeEnabled()
      await safeUi(page)
      await page.keyboard.press('Escape')
    } finally { await page.unroute('**/api/auth/logout') }
  })
  await page.goto(origin + base + '/events' + location)
}
