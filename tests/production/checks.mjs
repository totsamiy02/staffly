import assert from 'node:assert/strict'
import https from 'node:https'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ExcelJS from 'exceljs'
import { defaultReportConfig } from '../../src/app/schedule/reports/reporting.ts'

export async function runChecks({ origin, ca, password, fixture, check, compose, exec, fixtureAction, root, output }) {
  const lookup = (_hostname, _options, callback) => callback(null, '127.0.0.1', 4)
  function client() {
    const cookies = new Map()
    return {
      token: '', cookies,
      async request(pathname, { method = 'GET', json, bytes, headers = {}, cookie, trusted = true } = {}) {
        const body = bytes ?? (json === undefined ? undefined : Buffer.from(JSON.stringify(json)))
        return new Promise((resolve, reject) => {
          const request = https.request(new URL(pathname, origin), { family: 4, lookup, ...(trusted ? { ca } : {}), agent: false, method, timeout: 15000,
            headers: { Origin: origin, ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
              ...(cookies.size ? { Cookie: [...cookies].map(([key,value]) => key + '=' + value).join('; ') } : {}),
              ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(body ? { 'Content-Length': body.length } : {}), ...headers, ...(cookie === undefined ? {} : { Cookie: cookie }) } }, response => {
            const chunks = []
            for (const item of response.headers['set-cookie'] ?? []) { const [pair] = item.split(';'), index = pair.indexOf('='); cookies.set(pair.slice(0,index), pair.slice(index + 1)) }
            response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
            response.on('end', () => {
              const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
              try { resolve({ status: response.statusCode, headers: response.headers, bytes, text, json: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : undefined }) }
              catch { reject(new Error('API returned malformed JSON')) }
            })
          })
          request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Audit HTTPS request timed out'))); request.end(body)
        })
      },
    }
  }
  const owner = client(), employee = client(), base = '/api/organizations/' + fixture.organizationId
  const point = '?locationId=' + fixture.locationId
  const ok = (response, expected = 200) => { assert.equal(response.status, expected, `HTTP ${response.status}; expected ${expected}`); return response }
  await check('HTTPS validates the test certificate and serves the built SPA/assets with CSP', async () => {
    await assert.rejects(owner.request('/app', { trusted: false }))
    const html = ok(await owner.request('/app')); assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.match(html.headers['strict-transport-security'], /max-age=/)
    const asset = html.text.match(/src="(\/assets\/[^" ]+\.js)"/); assert.ok(asset)
    ok(await owner.request(asset[1])); ok(await owner.request('/health/ready'),404); ok(await owner.request('/internal/metrics'),404)
  })
  await check('password login issues Secure HttpOnly cookies; wrong-origin mutations are rejected', async () => {
    for (const [api, email] of [[owner,'owner@example.test'],[employee,'employee@example.test']]) {
      const login = ok(await api.request('/api/auth/login', { method: 'POST', json: { email, password } }))
      api.token = login.json.accessToken; assert.ok(api.token)
      assert.ok(login.headers['set-cookie'].some(value => /^staffly_refresh=/.test(value) && /HttpOnly/i.test(value) && /Secure/i.test(value)))
    }
    ok(await owner.request('/api/auth/refresh', { method: 'POST', headers: { Origin: 'https://untrusted.test' } }),403)
  })
  await check('parallel refresh and a lost-response retry work across the API pool', async () => {
    const cookie = [...owner.cookies].map(([key,value]) => key + '=' + value).join('; ')
    const responses = await Promise.all([1,2].map(() => owner.request('/api/auth/refresh', { method: 'POST', cookie })))
    for (const response of responses) { ok(response); assert.ok(response.json.accessToken) }
    owner.token = ok(await owner.request('/api/auth/refresh', { method: 'POST', cookie })).json.accessToken
    ok(await owner.request('/api/organizations'))
  })
  await check('nginx streams SSE immediately instead of buffering live updates', () => new Promise((resolve, reject) => {
    const started = Date.now()
    const request = https.request(new URL('/api/live?organizationId=' + fixture.organizationId, origin), { ca, lookup, family: 4, headers: { Authorization: 'Bearer ' + owner.token }, timeout: 5000 }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/event-stream')) { request.destroy(); reject(new Error('SSE endpoint is unavailable')); return }
      let received = ''
      response.on('data', bytes => { received += bytes; if (received.includes('event: ready')) { request.destroy(); resolve({ firstEventMs: Date.now() - started }) } })
      response.on('error', error => { if (!received.includes('event: ready')) reject(error) })
    })
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('SSE was buffered or unavailable'))); request.end()
  }))
  let document
  const contents = Buffer.from('Shared-volume production audit ' + randomUUID())
  await check('a file uploaded through nginx is readable from each of the four API containers', async () => {
    const params = new URLSearchParams({ locationId: fixture.locationId, pointId: fixture.locationId, displayName: 'Production shared file', visibility: 'ORGANIZATION' })
    document = ok(await owner.request(base + '/documents?' + params, { method: 'PUT', bytes: contents, headers: { 'Content-Type': 'text/plain', 'X-File-Name': 'audit.txt' } }),201).json.document
    for (const service of ['api1','api2','api3','api4']) {
      const result = JSON.parse((await exec(service, `import {readFileSync} from 'node:fs'; const x=JSON.parse(readFileSync(0,'utf8')); const r=await fetch('http://127.0.0.1:3001'+x.path,{method:'POST',headers:{Origin:x.origin,Authorization:'Bearer '+x.token}}); console.log(JSON.stringify({status:r.status,body:await r.text()}));`, { path: base + '/documents/' + document.id + '/content?action=download&locationId=' + fixture.locationId, origin, token: owner.token })).trim())
      assert.equal(result.status,200); assert.equal(result.body,contents.toString())
    }
    assert.equal(ok(await employee.request(base + '/documents/' + document.id + '/content?action=download&locationId=' + fixture.locationId, { method: 'POST' })).text, contents.toString())
  })
  await check('an Office upload reaches the isolated file processor in the production image', async () => {
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Audit').addRow(['Production audit',42])
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const params = new URLSearchParams({ locationId: fixture.locationId, pointId: fixture.locationId, displayName: 'Office audit', visibility: 'ORGANIZATION' })
    const item = ok(await owner.request(base + '/documents?' + params, { method: 'PUT', bytes, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': 'audit.xlsx' } }),201).json.document
    const downloaded = ok(await owner.request(base + '/documents/' + item.id + '/content?action=download&locationId=' + fixture.locationId, { method: 'POST' }))
    assert.deepEqual(downloaded.bytes,bytes)
  })
  await check('a queued export survives a worker stop and downloads a valid Excel after restart', async () => {
    await compose('stop','--timeout','15','worker')
    const key = randomUUID(), input = { from: fixture.date, to: fixture.date, locationIds: [fixture.locationId], memberIds: [], includeFormer: false, config: defaultReportConfig(), requestKey: key }
    const path = base + '/statistics/reports/export' + point
    const job = ok(await owner.request(path, { method: 'POST', json: input }),202).json.job
    await delay(1300)
    const status = base + '/statistics/reports/exports/' + job.id + point
    assert.equal(ok(await owner.request(status)).json.status,'PENDING', 'APIs must not run background export workers')
    assert.equal(ok(await owner.request(path, { method: 'POST', json: input }),202).json.job.id,job.id)
    await compose('start','worker')
    let ready = false
    for (let i=0;i<60;i++) {
      const current = ok(await owner.request(status)).json
      assert.notEqual(current.status,'FAILED','Production export failed; inspect its safe error reference in container logs')
      if (current.status === 'READY') { ready = true; break }
      await delay(500)
    }
    assert.ok(ready,'Worker must complete the queued export within 30 seconds')
    const bytes = ok(await owner.request(base + '/statistics/reports/exports/' + job.id + '/content' + point)).bytes
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes)
    assert.ok(workbook.worksheets.length >= 2)
    const values = workbook.worksheets.flatMap(sheet => sheet.getSheetValues().flat(Infinity))
    assert.ok(values.some(value => typeof value === 'string' && value.includes('ПродакшенАудит')))
    assert.ok(values.includes(480) || values.includes(8), 'Export must contain the seeded eight-hour shift')
    assert.equal((await fixtureAction('export-count')).count,1,'A lost response or duplicate POST must not create another export')
    return { worksheets: workbook.worksheets.length, bytes: bytes.length }
  })
  await check('revoking membership blocks direct file links and organization lists', async () => {
    await fixtureAction('revoke',fixture)
    const denied = await employee.request(base + '/documents/' + document.id + '/content?action=download&locationId=' + fixture.locationId, { method: 'POST' })
    assert.ok([403,404].includes(denied.status)); assert.equal(denied.text.includes(contents.toString()),false)
    assert.equal(ok(await employee.request('/api/organizations')).json.organizations.some(org => org.id === fixture.organizationId),false)
  })
  await check('stopping the worker during rendering requeues and completes the same export', async () => {
    await exec('worker',`import {spawn} from 'node:child_process'; import {access} from 'node:fs/promises'; import {setTimeout as delay} from 'node:timers/promises'; const child=spawn(process.execPath,['tests/production/renderer-watch.mjs'],{detached:true,stdio:'ignore',env:{}}); child.unref(); for(let i=0;i<200;i++){try{await access('/tmp/audit-renderer-ready'); process.exit(0)}catch{await delay(10)}} throw new Error('Renderer watcher did not start');`)
    const input = { from: fixture.date, to: fixture.date, locationIds: [fixture.locationId], memberIds: [], includeFormer:false, config:defaultReportConfig(), requestKey:randomUUID() }
    const job = ok(await owner.request(base+'/statistics/reports/export'+point,{method:'POST',json:input}),202).json.job
    await exec('worker',`import {readFile} from 'node:fs/promises'; import {setTimeout as delay} from 'node:timers/promises'; let found=false; for(let i=0;i<1000;i++){try{const pid=Number(await readFile('/tmp/audit-renderer-paused','utf8')); if(pid>0){found=true;break}}catch{} await delay(10)} if(!found)throw new Error('Renderer was not observed while running');`)
    const status = base+'/statistics/reports/exports/'+job.id+point
    assert.equal(ok(await owner.request(status)).json.status,'RUNNING')
    await compose('stop','--timeout','15','worker')
    assert.equal(ok(await owner.request(status)).json.status,'PENDING','Interrupted render must be retried, not lost or marked permanently failed')
    await compose('start','worker')
    let ready=false
    for(let i=0;i<60;i++){const current=ok(await owner.request(status)).json; assert.notEqual(current.status,'FAILED'); if(current.status==='READY'){ready=true;break} await delay(500)}
    assert.ok(ready,'The same export must finish after restart')
    const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(ok(await owner.request(base+'/statistics/reports/exports/'+job.id+'/content'+point)).bytes)
    assert.equal(workbook.worksheets.length,4)
    assert.equal((await fixtureAction('export-count')).count,2,'Recovery must reuse the interrupted job')
  })
  await check('document removal, restore and permanent cleanup work on the shared volume', async () => {
    const path = base + '/documents/' + document.id
    ok(await owner.request(path + point, { method: 'DELETE' }),204)
    ok(await owner.request(path + '/restore' + point, { method: 'POST' }),204)
    assert.equal(ok(await owner.request(path + '/content?action=download&locationId=' + fixture.locationId, { method: 'POST' })).text, contents.toString())
    ok(await owner.request(path + point, { method: 'DELETE' }),204)
    ok(await owner.request(path + '/content' + point, { method: 'DELETE', json: { confirm: true } }))
    const denied = await owner.request(path + '/content?action=download&locationId=' + fixture.locationId, { method: 'POST' })
    assert.ok([404,409,410].includes(denied.status))
  })
  await check('subscription changes synchronize storage ceilings without granting quota writes', async () => {
    const limit = async () => ok(await owner.request(base + '/resources' + point)).json.storage.limitBytes
    assert.equal(await limit(),10*1024**3)
    ok(await owner.request(base + '/subscription/free' + point,{method:'POST',json:{confirm:true,immediate:true}}))
    assert.equal(await limit(),250*1024**2)
    const order = ok(await owner.request(base + '/subscription/checkout' + point,{method:'POST',json:{plan:'TEAM'}}),201).json.order
    ok(await owner.request(base + '/subscription/purchases/' + order.id + '/test-activation' + point,{method:'POST',json:{confirm:true,mode:'test',email:'owner@example.test'}}))
    assert.equal(await limit(),2*1024**3)
  })
  await check('nginx continues serving after one API stops and the pool recovers after restart', async () => {
    const started = Date.now()
    await compose('stop','--timeout','15','api4')
    let consecutive = 0, transientErrors = 0
    for (let i=0;i<30 && consecutive<5;i++) {
      const response = await owner.request('/api/organizations')
      if (response.status === 200) consecutive++; else { assert.ok([502,503,504].includes(response.status)); transientErrors++; consecutive=0 }
      await delay(200)
    }
    assert.equal(consecutive,5,'The remaining API pool must serve successfully')
    await compose('up','-d','--no-deps','--wait','--wait-timeout','60','api4')
    return { transientErrors, stopAndRecoveryMs: Date.now()-started }
  })
  await check('the built frontend logs in and opens documents through HTTPS/nginx', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root,'artifacts/browser-binaries')
    const { chromium, expect } = await import('playwright/test')
    // Trust only this run's certificate key, without changing the OS trust store.
    // Node HTTPS above independently validates both the CA and hostname.
    const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const browser = await chromium.launch({ headless: true, executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, args: ['--host-resolver-rules=MAP staffly.test 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] })
    try {
      const context = await browser.newContext({ locale:'ru-RU', reducedMotion:'reduce', viewport:{width:1440,height:1000} })
      await context.addInitScript(() => localStorage.setItem('staffly-cookie-consent','necessary'))
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(origin + '/auth')
      await page.locator('input[name="email"]').fill('owner@example.test')
      await page.locator('input[name="password"]').fill(password)
      await page.getByRole('button',{name:'Войти',exact:true}).click()
      await expect(page.getByRole('button',{name:'Открыть профиль',exact:true})).toBeVisible({timeout:20000})
      await page.goto(origin + '/app/organizations/' + fixture.organizationId + '/documents?location=' + fixture.locationId)
      await expect(page.getByRole('heading',{name:'Документы',exact:true})).toBeVisible()
      await expect(page.getByRole('region',{name:'Системные папки',exact:true})).toBeVisible()
      await page.screenshot({path:path.join(output,'production-documents.png'),fullPage:true})
      assert.deepEqual(errors,[],'Built frontend must have no runtime JavaScript errors')
    } finally { await browser.close() }
  })
}
