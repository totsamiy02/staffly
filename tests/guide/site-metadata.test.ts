import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createSiteRouter } from '../../src/server/site/router.ts'
import { metadataHead, pageMetadata, sitemapPaths, type SitePublication } from '../../src/shared/site/metadata.ts'

test('public metadata escapes editor text, canonical URLs exclude queries and private paths stay private', () => {
  const meta = pageMetadata('/contacts', [{ key: 'contacts', title: '<script> & $&', metadata: { summary: '"Контакты"' } }])
  const head = metadataHead(meta, 'https://staffly.test')
  assert.match(head, /&lt;script&gt; &amp; \$&amp;/)
  assert.match(head, /&quot;Контакты&quot;/)
  assert.match(head, /rel="canonical" href="https:\/\/staffly.test\/contacts"/)
  for (const path of ['/app/organizations/secret', '/admin/users', '/reset-password', '/auth/yandex', '/workspace']) {
    const privateHead = metadataHead(pageMetadata(path), 'https://staffly.test')
    assert.match(privateHead, /noindex, nofollow/)
    assert.doesNotMatch(privateHead, /canonical|og:url|secret/)
  }
  assert.equal(pageMetadata('/guide/category/missing').status, 404)
  assert.equal(pageMetadata('/guide/missing').status, 404)
  assert.equal(pageMetadata('/guide/category/management').index, true)
})

test('sitemap contains static and published guide URLs only, without duplicate overrides', () => {
  const paths = sitemapPaths([{ key: 'guide:new-public-article', title: 'Новая' }, { key: 'guide:profile', title: 'Профиль' }, { key: 'legal:terms', title: 'Условия' }])
  assert(paths.includes('/contacts') && paths.includes('/guide/new-public-article'))
  assert.equal(paths.filter(p => p === '/guide/profile').length, 1)
  assert(!paths.some(p => /app|admin|auth|\?|#/.test(p)))
})

test('server HTML and sitemap reflect publication updates without JS; private routes need no catalog', async () => {
  let items: SitePublication[] = [{ key: 'guide:new-public-article', title: 'Первая версия', metadata: { summary: 'Описание статьи' } }]
  let unavailable = false
  const app = express()
  app.use(createSiteRouter({ origin: 'https://staffly.test', publications: async () => { if (unavailable) throw new Error('Catalog unavailable'); return items }, template: async () => '<html><head><!--staffly-head:start--><title>hr</title><!--staffly-head:end--></head><body><div id="root"></div></body></html>' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  try {
    let response = await fetch(origin + '/guide/new-public-article?q=secret')
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /Первая версия — Staffly/)
    assert.match(html, /property="og:description" content="Описание статьи"/)
    assert.doesNotMatch(html, /q=secret|<title>hr/)
    items = [{ key: 'guide:new-public-article', title: 'Версия $& <2>', body: 'Обновлённое описание' }, { key: 'guide:second-article', title: 'Вторая статья' }]
    html = await (await fetch(origin + '/guide/new-public-article')).text()
    assert.match(html, /Версия \$&amp; &lt;2&gt; — Staffly/)
    assert.match(html, /Обновлённое описание/)
    const sitemap = await (await fetch(origin + '/sitemap.xml')).text()
    assert.match(sitemap, /https:\/\/staffly.test\/guide\/second-article/)
    assert.doesNotMatch(sitemap, /\/app|\/admin|\/auth/)
    const robots = await (await fetch(origin + '/robots.txt')).text()
    assert.match(robots, /Disallow: \/admin/)
    assert.match(robots, /Sitemap: https:\/\/staffly.test\/sitemap.xml/)
    response = await fetch(origin + '/guide/no-such-article')
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
    response = await fetch(origin + '/cookie-policy', { redirect: 'manual' })
    assert.equal(response.headers.get('location'), '/privacy-policy#cookies')
    response = await fetch(origin + '/guide/', { redirect: 'manual' })
    assert.equal(response.headers.get('location'), 'https://staffly.test/guide')
    response = await fetch(origin + '//outside.test/', { redirect: 'manual' })
    assert.equal(new URL(response.headers.get('location')!).origin, 'https://staffly.test')
    // Auth shells must work even if the public catalog is unavailable.
    unavailable = true
    response = await fetch(origin + '/admin/users?token=secret')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.doesNotMatch(await response.text(), /token=secret|canonical|og:url/)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
