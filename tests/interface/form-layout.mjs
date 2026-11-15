import assert from 'node:assert/strict'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'

export async function checkFormLayouts({ page, origin, base, location, output, name, viewport, expect }) {
  const fit = async surface => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    for (const box of await surface.locator('input[type=checkbox]').all()) {
      const style = await box.evaluate(node => {
        const css = getComputedStyle(node)
        return { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, padding: css.padding, image: css.backgroundImage, checked: node.checked }
      })
      assert(style.width >= 16 && style.width <= 20 && style.height >= 16 && style.height <= 20, JSON.stringify(style))
      assert.equal(style.padding, '0px')
      if (style.checked) assert.notEqual(style.image, 'none', 'Checked control must show a check mark')
    }
    const audit = await new AxeBuilder({ page }).include(await surface.evaluate(node => '.' + [...node.classList].join('.'))).withTags(['wcag2a', 'wcag2aa']).analyze()
    assert.deepEqual(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [])
  }
  const close = async dialog => {
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
    const warning = page.getByRole('dialog', { name: 'Есть несохранённые изменения', exact: true })
    if (await warning.isVisible()) await warning.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  await page.goto(origin + base + '/events' + location)
  await page.getByRole('button', { name: 'Создать событие', exact: true }).first().click()
  const event = page.getByRole('dialog', { name: 'Новое событие', exact: true })
  await expect(event).toBeVisible()
  await event.getByRole('checkbox', { name: 'Указать окончание', exact: true }).check()
  await event.getByRole('checkbox', { name: /Важное событие/ }).check()
  await fit(event)
  await event.evaluate(node => { node.scrollTop = 0 })
  await event.screenshot({ path: path.join(output, `${name}-${viewport}-event-layout.png`) })
  await close(event)
  await page.goto(origin + base + '/settings?section=requests')
  await page.getByRole('button', { name: '+ Создать тип', exact: true }).click()
  const builder = page.getByRole('dialog', { name: 'Новый тип заявки', exact: true })
  await expect(builder).toBeVisible()
  await builder.locator('summary').filter({ hasText: 'Даты, комментарий и вложения' }).click()
  await builder.getByRole('checkbox', { name: 'Обязательный комментарий', exact: true }).check()
  await builder.getByRole('button', { name: '+ Добавить вопрос', exact: true }).click()
  await builder.locator('summary').filter({ hasText: 'Дополнительные настройки' }).click()
  await fit(builder)
  await builder.evaluate(node => { node.scrollTop = 0 })
  await builder.screenshot({ path: path.join(output, `${name}-${viewport}-builder-layout.png`) })
  await close(builder)
  const settings = page.locator('.request-types-settings')
  await page.getByRole('button', { name: /Праздничные дни организации/ }).click()
  const holiday = settings.locator('.holiday-editor')
  const toggle = holiday.getByRole('button', { name: /Праздничные дни организации/ })
  const beforeHover = await toggle.boundingBox()
  await toggle.hover()
  const afterHover = await toggle.boundingBox()
  assert.deepEqual(afterHover, beforeHover, 'Hover must not move or resize the holiday toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(holiday.locator('.holiday-editor__collapse')).toHaveJSProperty('inert', true)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await holiday.getByRole('button', { name: 'О праздничных днях', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toContainText('Федеральные праздники уже учтены')
  await toggle.focus()
  await page.mouse.move(0, 0)
  await fit(settings)
  await settings.screenshot({ path: path.join(output, `${name}-${viewport}-request-settings-layout.png`) })
}
