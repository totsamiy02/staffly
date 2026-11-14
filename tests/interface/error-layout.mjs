import assert from 'node:assert/strict'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'

export async function checkErrorLayouts({ page, origin, viewport, theme, output, check, expect }) {
  const originalSize = page.viewportSize()
  const widths = viewport === 'mobile' ? [320, 390] : [768, 1440]
  await page.route('**/api/support/client-errors', route => route.fulfill({ status: 202, json: {} }))

  async function readableReferences() {
    for (const reference of await page.locator('.request-error-reference').all()) {
      const geometry = await reference.evaluate(node => {
        const code = node.querySelector('code')
        const button = node.querySelector('button')
        const label = node.querySelector('.copy-reference__label')
        return {
          width: node.clientWidth,
          scroll: node.scrollWidth,
          font: parseFloat(getComputedStyle(code).fontSize),
          code: code.getBoundingClientRect().toJSON(),
          button: button.getBoundingClientRect().toJSON(),
          label: label.getBoundingClientRect().toJSON()
        }
      })
      assert(geometry.scroll <= geometry.width + 1, 'Support reference must not overflow')
      assert(geometry.font >= 11 && geometry.font <= 14, 'Support code must use readable type')
      assert(geometry.code.right <= geometry.button.left + 1, 'Copy control must not overlap the code')
      assert(geometry.label.bottom <= geometry.code.top + 1, 'Support label must sit above the code')
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  }

  async function capture(surface, width) {
    await readableReferences()
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    assert.deepEqual(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [])
    await page.screenshot({ path: path.join(output, `errors-${theme}-${width}-${surface}.png`), fullPage: true })
  }

  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      for (const surface of ['404', '500', 'module', 'inline', 'admin', 'toast']) {
        await check(`${surface} errors remain readable at ${width}px`, async () => {
          const url = surface === '404' ? '/not-a-real-page' : `/__profile-error?theme=${theme}&surface=${surface}`
          await page.goto(origin + url)
          await expect(page.locator('main')).toBeVisible()
          if (surface === 'toast') {
            await page.getByRole('button', { name: 'Показать ошибку', exact: true }).click()
            const toast = page.locator('.staffly-toast')
            await expect(toast).toContainText('Сервис временно недоступен')
            await toast.hover()
            const message = await toast.locator('.request-error-message > span:first-child').boundingBox()
            const close = await toast.getByRole('button', { name: 'Закрыть сообщение' }).boundingBox()
            const position = await toast.boundingBox()
            assert(position && position.y >= 0 && position.y <= 32, 'Toast must stay at the top of the viewport')
            assert(message && close && message.x + message.width <= close.x + 1, 'Close must not overlap the message')
            await capture(surface, width)
            const copy = toast.getByRole('button', { name: 'Скопировать код для поддержки' })
            await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: { writeText: async value => { window.__copiedSupport = value } }
            }))
            await copy.click()
            await expect(toast).toContainText('Скопировано')
            assert.equal(await page.evaluate(() => window.__copiedSupport), '21822b7b-6686-435b-bb84-771defc187aa')
            await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: { writeText: async () => { throw new Error('Synthetic permission denial') } }
            }))
            await copy.click()
            await expect(toast).toContainText('скопируйте вручную')
            assert.equal(await page.evaluate(() => getSelection()?.toString()), '21822b7b-6686-435b-bb84-771defc187aa')
            await readableReferences()
            await toast.getByRole('button', { name: 'Закрыть сообщение' }).focus()
            await page.keyboard.press('Enter')
            await expect(toast).toBeHidden()
            for (const [trigger, text] of [['Длинная ошибка', 'Проверьте соединение'], ['Успешное действие', 'Изменения сохранены.'], ['Информация', 'Данные обновлены.']]) {
              await page.getByRole('button', { name: trigger, exact: true }).click()
              await expect(toast).toContainText(text)
              await toast.hover()
              await readableReferences()
              if (trigger === 'Длинная ошибка') await capture('toast-long', width)
              await toast.getByRole('button', { name: 'Закрыть сообщение' }).click()
              await expect(toast).toBeHidden()
            }
          } else {
            if (['500', 'module'].includes(surface)) await expect(page.locator('.request-error-reference')).toBeVisible()
            if (['404', '500'].includes(surface)) {
              const family = await page.locator('main').evaluate(node => getComputedStyle(node).fontFamily)
              assert(family.includes('Arial'), 'Error pages must use the common font')
              for (const action of await page.locator('.status-page__actions > *').all()) {
                assert((await action.boundingBox()).height >= 44, 'Page recovery controls must be large enough to tap')
              }
            }
            await capture(surface, width)
            if (surface === 'inline') {
              const state = page.locator('.request-error-state')
              const message = await state.locator('.request-error-message').boundingBox()
              const retry = await state.getByRole('button', { name: 'Повторить', exact: true }).boundingBox()
              assert(message && retry && retry.y >= message.y + message.height, 'Retry must sit below the message')
              await state.getByRole('button', { name: 'Повторить', exact: true }).click()
              await expect(page.locator('output')).toHaveText('Повтор запрошен')
            }
            if (surface === '404') {
              await expect(page.getByRole('link', { name: 'На главную', exact: true })).toHaveAttribute('href', '/')
              await expect(page.getByRole('link', { name: 'Мои организации', exact: true })).toHaveAttribute('href', '/app')
            }
          }
        })
      }
    }
  } finally {
    await page.setViewportSize(originalSize)
  }
}
