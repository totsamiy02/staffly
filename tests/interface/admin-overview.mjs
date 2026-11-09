import assert from 'node:assert/strict'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'

export async function checkOverview({ page, check, expect, noOverflow, output, tag }) {
  const overview = page.locator('.admin-overview')
  const originalSize = page.viewportSize()
  // Wait for boot-time auth rotation before replacing a document. WebKit reports
  // a navigation-aborted fetch as a page error even when the app handles it.
  const settle = () => page.waitForLoadState('networkidle')
  const go = async target => { await settle(); await page.goto(new URL(target, page.url()).href); await settle() }
  const reload = async () => { await settle(); await page.reload(); await settle() }
  await check('overview: KPI, system details and existing data remain available', async () => {
    await expect(overview.locator('.admin-overview-stat')).toHaveCount(4)
    await expect(overview.getByRole('heading', { name: 'Новые организации', exact: true })).toBeVisible()
    await expect(overview.getByRole('heading', { name: 'Сбор данных', exact: true })).toBeVisible()
    await expect(overview.locator('.admin-overview-check')).toHaveCount(4)
    for (const row of await overview.locator('.admin-overview-check').all()) {
      const button = row.getByRole('button')
      await button.focus()
      await page.keyboard.press('Enter')
      await expect(button).toHaveAttribute('aria-expanded', 'true')
      await expect(row.locator('.admin-disclosure-body a').last()).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(button).toHaveAttribute('aria-expanded', 'false')
    }
    await expect(overview.locator('.admin-overview-timeline li').first()).toBeVisible()
    assert.equal(await overview.locator('.admin-overview-stat').first().evaluate(node => getComputedStyle(node).fontFamily.includes('Inter')), true)
  })

  await check('overview: responsive composition at desktop, tablet and phone widths', async () => {
    for (const width of [1920, 1440, 1280, 1100, 1024, 820, 768, 600, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await noOverflow()
      assert(await overview.locator('.admin-overview-stat').evaluateAll(nodes => nodes.every(node => node.querySelector('h2').getBoundingClientRect().right <= node.getBoundingClientRect().right)), `${width}: KPI labels fit their cards`)
      const geometry = await overview.evaluate(node => {
        const rect = selector => { const box = node.querySelector(selector).getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom } }
        return { stats: [...node.querySelectorAll('.admin-overview-stat')].map(item => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y })), activity: rect('.admin-overview-activity'), system: rect('.admin-overview-system'), events: rect('.admin-overview-events'), online: rect('.admin-overview-online') }
      })
      assert(geometry.activity.bottom <= geometry.events.y + 1, `${width}: events follow activity`)
      assert(geometry.system.bottom <= geometry.online.y + 1, `${width}: online follows system`)
      if (width <= 1024) {
        assert(geometry.system.y >= geometry.activity.bottom - 1, `${width}: system stacks below activity`)
        assert(geometry.stats[2].y > geometry.stats[0].y, `${width}: KPI use two rows`)
      }
      if ([1440, 820, 390, 320].includes(width)) {
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
        await page.screenshot({ path: path.join(output, `overview-${tag}-${width}.png`), fullPage: true })
      }
    }
    await page.setViewportSize(originalSize)
    const accessibility = await new AxeBuilder({ page }).include('.admin-overview').analyze()
    assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [])
  })

  await check('overview: all six chart periods keep URL state and keyboard access', async () => {
    await go('/admin?days=1&keep=overview')
    for (const [days, label] of [[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [365, 'Год'], [0, 'Всё время'], [1, '24 часа']]) {
      const button = overview.getByRole('button', { name: label, exact: true })
      await button.focus(); await page.keyboard.press('Enter')
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      assert.equal(new URL(page.url()).searchParams.get('days'), String(days))
      assert.equal(new URL(page.url()).searchParams.get('keep'), 'overview')
    }
    await go('/admin')
  })

  await check('overview: recent event opens the existing journal with its filter', async () => {
    const link = overview.locator('.admin-overview-event-title').first()
    await expect(link).toBeVisible()
    const target = await link.getAttribute('href')
    await link.click()
    await expect(page.getByRole('heading', { name: 'События сервиса', exact: true })).toBeVisible()
    assert.equal(new URL(page.url()).search, new URL(target, page.url()).search)
    await go('/admin')
  })

  await check('overview: empty online and event lists explain their state', async () => {
    const summaryPattern = '**/api/admin/monitoring/overview**', eventsPattern = '**/api/admin/monitoring/events**'
    await page.route(summaryPattern, async route => { const response = await route.fetch(), data = await response.json(); data.online = { ...data.online, users: 0, organizations: 0, sessions: 0 }; data.onlineOrganizations = []; await route.fulfill({ response, json: data }) })
    await page.route(eventsPattern, route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } }))
    try {
      await reload()
      await expect(overview.getByText('Никого нет в сети', { exact: true })).toBeVisible()
      await expect(overview.getByText(/События ещё не зафиксированы/)).toBeVisible()
      await noOverflow()
    } finally { await page.unroute(summaryPattern); await page.unroute(eventsPattern) }
  })

  await check('overview: failed system and event requests allow recovery', async () => {
    const patterns = ['**/api/admin/attention', '**/api/admin/monitoring/events**']
    for (const pattern of patterns) await page.route(pattern, route => route.fulfill({ status: 503, json: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Временная ошибка проверки.' } }))
    try {
      await reload()
      await expect(overview.locator('.admin-overview-system').getByRole('button', { name: /Повторить/ })).toBeVisible()
      await expect(overview.locator('.admin-overview-events').getByRole('button', { name: /Повторить/ })).toBeVisible()
      await noOverflow()
    } finally { for (const pattern of patterns) await page.unroute(pattern) }
    await overview.locator('.admin-overview-system').getByRole('button', { name: /Повторить/ }).click()
    await overview.locator('.admin-overview-events').getByRole('button', { name: /Повторить/ }).click()
    await expect(overview.locator('.admin-overview-check')).toHaveCount(4)
    await expect(overview.locator('.admin-overview-event-title').first()).toBeVisible()
  })
}
