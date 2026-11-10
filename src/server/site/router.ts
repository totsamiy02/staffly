import { Router } from 'express'
import { readFile } from 'node:fs/promises'
import { pageMetadata, metadataHead, sitemapPaths, escapeMarkup, type SitePublication } from '../../shared/site/metadata.ts'

// Only the effective public view is injected here; drafts and personal data are never read.
export function createSiteRouter({ origin, publications, template = () => readFile(new URL('../../../dist/index.html', import.meta.url), 'utf8') }: { origin: string; publications: () => Promise<SitePublication[]>; template?: () => Promise<string> }) {
  const router = Router()
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex, nofollow'); next() })
  router.get('/robots.txt', (_request, response) => response.type('text/plain').send(`User-agent: *\nAllow: /\n${['/app','/admin','/workspace','/auth','/verify-email','/forgot-password','/reset-password','/api/','/internal/','/health/'].map(path => 'Disallow: ' + path).join('\n')}\nSitemap: ${origin}/sitemap.xml\n`))
  router.get('/sitemap.xml', async (_request, response) => {
    const items = await publications()
    response.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapPaths(items).map(path => `<url><loc>${escapeMarkup(origin + path)}</loc></url>`).join('')}</urlset>`)
  })
  router.get(/.*/, async (request, response, next) => {
    if (/^\/(api|health|internal|assets)(\/|$)/.test(request.path) || /\.[a-z0-9]+$/i.test(request.path) && request.path !== '/index.html') { next(); return }
    if (request.path === '/index.html') { response.redirect(308, '/'); return }
    if (request.path === '/cookie-policy') { response.redirect(308, '/privacy-policy#cookies'); return }
    if (request.path.length > 1 && request.path.endsWith('/')) { response.redirect(308, origin + request.path.replace(/\/+$/, '') + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '')); return }
    const privatePage = /^\/(app|admin|workspace|auth|verify-email|forgot-password|reset-password)(\/|$)/.test(request.path)
    // Fail closed on a public catalog failure: never cache an incomplete sitemap or a false 404.
    const [html, items] = await Promise.all([template(), privatePage ? Promise.resolve([]) : publications()])
    const meta = pageMetadata(request.path, items)
    response.set('X-Robots-Tag', meta.index ? 'index, follow' : 'noindex, nofollow')
    response.status(meta.status).type('html').send(html.replace(/<!--staffly-head:start-->[\s\S]*?<!--staffly-head:end-->/, () => '<!--staffly-head:start-->\n' + metadataHead(meta, origin) + '\n<!--staffly-head:end-->'))
  })
  return router
}
