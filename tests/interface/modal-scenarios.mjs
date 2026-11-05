export async function modalScenarios({ page, origin, fixture, capture }) {
  const base = `/app/organizations/${fixture.org.id}`
  const cases = [
    ['event-form', base + '/events', /Создать событие/],
    ['document-form', base + '/documents', /Загрузить документ/],
    ['folder-form', base + '/documents', /Создать папку/],
    ['shift-form', base + '/schedule', /Добавить смену/],
    ['report-form', base + '/schedule/statistics', /Выгрузить Excel/],
    ['location-form', base + '/settings?section=locations', /Добавить точку/],
    ['role-form', base + '/settings?section=roles', /Создать роль/, '.access-role-page'],
    ['request-type', base + '/requests?tab=mine', /Создать заявку/],
  ]
  for (const [name, route, button, inline] of cases) {
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' })
    await page.locator('main:not(.app-loading):not(.route-loading)').first().waitFor()
    const trigger = page.getByRole('button', { name: button }).first()
    try {
      await trigger.waitFor({ timeout: 10000 }); await trigger.focus(); await page.keyboard.press('Enter')
      if (inline) { await page.locator(inline).waitFor(); await capture(name, page); continue }
      const dialog = page.locator('[aria-modal=true]').last()
      await dialog.waitFor({ timeout: 5000 })
      await capture(name, page)
      if (name === 'document-form') {
        const summary = dialog.locator('.document-audience-preview summary')
        await summary.waitFor(); await summary.focus(); await page.keyboard.press('Enter')
        await capture('document-form-audience', page)
      }
      const count = await dialog.locator('button:visible,input:visible,textarea:visible,[tabindex="0"]:visible').count()
      let trapped = true
      for (let index = 0; index < Math.min(count + 3, 45); index++) {
        await page.keyboard.press('Tab')
        if (!await dialog.evaluate(element => element.contains(document.activeElement))) { trapped = false; break }
      }
      if (!trapped) throw new Error('Keyboard focus escaped the dialog')
      const popup = await page.locator('[role=tooltip]:visible,[role=listbox]:visible,.staffly-calendar:visible,.staffly-month-popup:visible').count()
      await page.keyboard.press('Escape')
      if (popup && await dialog.isVisible()) await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
      if (!await trigger.evaluate(element => element === document.activeElement)) throw new Error('Dialog did not restore focus to its trigger')
    } catch (error) { await capture(name, page, error.message) }
  }
  for (const [name, label] of [['vacation', 'Отпуск'], ['day-off', 'Отгул'], ['absence-message', 'Сообщить об отсутствии'], ['absence', 'Освобождение от работы'], ['propose-shift', 'Предложить смену'], ['change-shift', 'Изменение смены'], ['other', 'Другое']]) {
    await page.goto(origin + base + '/requests?tab=mine')
    const trigger = page.getByRole('button', { name: 'Создать заявку', exact: true }).first()
    try {
      await trigger.waitFor(); await trigger.focus(); await page.keyboard.press('Enter')
      const choice = page.locator('.request-type-choice-list button').filter({ has: page.getByText(label, { exact: true }) })
      await choice.waitFor(); await choice.focus(); await page.keyboard.press('Enter')
      const dialog = page.locator('.request-form-dialog'); await dialog.waitFor()
      await capture(`request-${name}-form`, page)
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
      if (!await trigger.evaluate(e => e === document.activeElement)) throw new Error('Request form did not restore focus')
    } catch (error) { await capture(`request-${name}-form`, page, error.message) }
  }
  await page.goto(origin + base + '/requests?tab=incoming')
  try {
    const trigger = page.locator('.request-row > .staffly-action-surface__open').first()
    await trigger.waitFor(); await trigger.focus(); await page.keyboard.press('Enter')
    const dialog = page.locator('.request-detail-dialog'); await dialog.waitFor()
    await capture('request-detail', page)
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  } catch (error) { await capture('request-detail', page, error.message) }
  await page.goto(origin + base + '/employees')
  try {
    const trigger = page.locator('.member-profile-trigger').first()
    await trigger.waitFor(); await trigger.focus(); await page.keyboard.press('Enter')
    const dialog = page.locator('[aria-modal=true]').last(); await dialog.waitFor()
    await capture('employee-profile', page)
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  } catch (error) { await capture('employee-profile', page, error.message) }
}
