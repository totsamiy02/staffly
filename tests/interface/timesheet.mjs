import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer as socketServer } from 'node:net'

export async function runTimesheet({ prisma, env, root, output, options, temporary, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries')
  const { chromium, expect } = await import('playwright/test')
  const { createBusinessOrganization } = await import('../support/business-organization.ts')
  const socket = socketServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  env.APP_ORIGIN = origin
  env.RUN_BACKGROUND_WORKERS = 'false'
  const api = await startApi()
  const { devApiProxy } = await import('../../scripts/dev-api-proxy.ts')
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-timesheet'), plugins: [react(),devApiProxy(Number(new URL(api).port))], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**','**/storage/**','**/docs/**','**/src/server/**','**/src/generated/**'] } }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true })
  const result = { checks: [], screenshots: [], errors: [] }
  try {
    for (const theme of options.theme ? [options.theme] : ['light','dark']) {
      for (const viewport of ['desktop','mobile']) {
        const context = await browser.newContext({ viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce', acceptDownloads: true })
        await context.addInitScript(theme => { localStorage.setItem('staffly.theme',theme);localStorage.setItem('staffly-cookie-consent','necessary') },theme)
        const user = await prisma.user.create({ data: { email: `tab-browser-${randomUUID()}@example.test`, firstName: 'Анна', lastName: 'Смирнова', passwordHash: 'synthetic-only', emailVerifiedAt: new Date() } })
        const org = await createBusinessOrganization(user.id,{ name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow' })
        await prisma.organizationLocation.update({where:{id:org.locationId},data:{name:'Центральная'}})
        const member = await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } }, data: { personnelFirstName: 'Анна', personnelLastName: 'Смирнова', personnelNumber: '0001', joinedAt: new Date('2020-01-01') } })
        await prisma.locationMember.update({ where: { locationId_memberId: { locationId: org.locationId, memberId: member.id } }, data: { joinedAt: new Date('2020-01-01') } })
        const employee = await prisma.user.create({data:{email:`tab-worker-${randomUUID()}@example.test`,firstName:'Михаил',lastName:'Соколов'}})
        const worker = await prisma.organizationMember.create({data:{organizationId:org.id,userId:employee.id,personnelFirstName:'Михаил',personnelLastName:'Соколов',personnelNumber:'0012',joinedAt:new Date('2020-01-01')}})
        await prisma.locationMember.create({data:{organizationId:org.id,locationId:org.locationId,memberId:worker.id,joinedAt:new Date('2020-01-01')}})
        const shifts = await prisma.workShift.createManyAndReturn({data:[
          {organizationId:org.id,locationId:org.locationId,memberId:member.id,createdByMemberId:member.id,scheduledStartAt:new Date('2025-10-02T06:00:00Z'),scheduledEndAt:new Date('2025-10-02T15:00:00Z'),positionNameSnapshot:'Администратор'},
          {organizationId:org.id,locationId:org.locationId,memberId:worker.id,createdByMemberId:member.id,scheduledStartAt:new Date('2025-10-03T06:00:00Z'),scheduledEndAt:new Date('2025-10-03T15:00:00Z'),actualStartAt:new Date('2025-10-03T06:30:00Z'),actualEndAt:new Date('2025-10-03T15:00:00Z'),attendance:'PARTIAL',positionNameSnapshot:'Бариста'},
        ]})
        await prisma.employeeAbsence.createMany({data:[
          {organizationId:org.id,memberId:worker.id,type:'VACATION',startDate:new Date('2025-10-06'),endDate:new Date('2025-10-12')},
          {organizationId:org.id,memberId:member.id,type:'SICK',startDate:new Date('2025-10-20'),endDate:new Date('2025-10-22')},
        ]})
        const refresh = randomUUID()+randomUUID(), browserToken = randomBytes(48).toString('base64url')
        await prisma.authSession.create({data:{userId:user.id,browserTokenHash:createHash('sha256').update(browserToken).digest('hex'),refreshTokenHash:createHash('sha256').update(refresh).digest('hex'),idleExpiresAt:new Date(Date.now()+3600000),absoluteExpiresAt:new Date(Date.now()+3600000)}})
        await context.addCookies([{name:'staffly_refresh',value:refresh,domain:'127.0.0.1',path:'/api/auth',httpOnly:true,sameSite:'Lax'},{name:'staffly_browser',value:browserToken,domain:'127.0.0.1',path:'/api/auth',httpOnly:true,sameSite:'Lax'}])
        const page = await context.newPage()
        let authorization
        page.on('request',request=>{if(request.headers().authorization)authorization=request.headers().authorization})
        page.on('pageerror',error=>result.errors.push(error.message))
        const url = `${origin}/app/organizations/${org.id}/schedule/timesheet?month=2025-10&location=${org.locationId}`
        const shot = async name => {
          const closeNotice = page.getByRole('button',{name:'Закрыть сообщение',exact:true})
          if (await closeNotice.isVisible()) await closeNotice.click()
          await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}))
          const filename = `${viewport}-${theme}-timesheet-${name}.png`
          await page.screenshot({path:path.join(output,filename),fullPage:true})
          result.screenshots.push(filename)
        }
        const fit = async () => {
          await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),{message:'Responsive layout settles without page overflow'}).toBeLessThanOrEqual(1)
          const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
          if(sizes.scroll>sizes.width+1){
            const overflow=await page.locator('body *').evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,cls:node.className,right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width})).filter(item=>item.right>document.documentElement.clientWidth+1))
            await writeFile(path.join(output,'overflow.json'),JSON.stringify({sizes,overflow},null,2))
          }
          assert(sizes.scroll<=sizes.width+1,'Timesheet must fit viewport')
        }
        try {
          await page.goto(`${origin}/app/organizations/${org.id}/schedule?month=2025-10&day=2025-10-02&location=${org.locationId}`)
          const day = page.getByRole('dialog', { name: /Расписание на день:/ })
          await expect(day.locator('.day-schedule-card__time')).toContainText('Предварительно')
          await expect(day.locator('.day-schedule-card__time')).toContainText('Подтверждено—')
          await fit()
          await shot('day-accounting')
          await day.getByRole('button', { name: 'Закрыть расписание дня', exact: true }).click()
          const timesheetTab = page.getByRole('link', { name: 'Табель', exact: true })
          await expect(timesheetTab).toBeVisible()
          await expect(page.locator('.schedule-module-tabs a')).toHaveText(['Календарь','Рабочее время','Статистика','История смен','Табель'])
          await expect(page.locator('.schedule-navigation__tools').getByRole('button', { name: /Выгрузка Excel/ })).toHaveCount(0)
          await timesheetTab.click()
          await expect(page).toHaveURL(new RegExp('/schedule/timesheet\\?month=2025-10'))
          await expect(page.getByRole('heading',{name:'Табель рабочего времени',exact:true})).toBeVisible()
          await expect(page.locator('.timesheet-checks')).toContainText('подтвердите факт')
          await fit();await shot('open')
          await page.goto(`${origin}/app/organizations/${org.id}/schedule/statistics?month=2025-10&location=${org.locationId}`)
          await expect(page.locator('.work-time-totals')).toContainText('8 ч 30 мин')
          await expect(page.locator('.work-time-attention')).toContainText('1 смен')
          await expect(page.getByRole('button', { name: 'Выгрузить Excel', exact: true })).toHaveCount(0)
          const employeeSearch = page.getByRole('searchbox', { name: 'Поиск сотрудника', exact: true })
          await employeeSearch.fill('соколов')
          await expect(page.locator('.statistics-table__row')).toHaveCount(1)
          await expect(page.locator('.statistics-table__row')).toContainText('Соколов Михаил')
          await expect(page.locator('.work-time-totals')).toContainText('8 ч 30 мин')
          await shot('statistics-search')
          await employeeSearch.fill('Такого сотрудника нет')
          await expect(page.getByRole('heading', { name: 'Сотрудники не найдены', exact: true })).toBeVisible()
          await employeeSearch.fill(employee.email)
          await expect(page.locator('.statistics-table__row')).toHaveCount(1)
          await employeeSearch.fill('')
          await expect(page.locator('.statistics-table__row')).toHaveCount(2)
          for (const width of [320, 768]) {
            await page.setViewportSize({ width, height: 900 })
            await fit()
          }
          await page.setViewportSize(viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 })
          await fit();await shot('statistics')
          await page.getByRole('button',{name:'Правила расчёта',exact:true}).click()
          const rules = page.getByRole('dialog',{name:'Правила расчёта времени',exact:true})
          await expect(rules).toContainText('Перерывы включены')
          await shot('calculation-rules')
          await rules.getByRole('button',{name:'Понятно',exact:true}).click()
          await page.getByRole('button',{name:'Разобрать',exact:true}).click()
          const marks = page.getByRole('dialog',{name:'Исправить рабочее время',exact:true})
          await expect(marks.getByRole('button',{name:'Подтвердить по плану',exact:true})).toBeEnabled()
          await marks.getByLabel('Фактический приход',{exact:true}).fill('09:30')
          await expect(marks.locator('.time-correction-result')).toContainText('Предварительно')
          await expect(marks.locator('footer')).toBeInViewport({ratio:1})
          await shot('incomplete-marks')
          await marks.getByRole('button',{name:'Сохранить отметки',exact:true}).click()
          await expect(marks).toBeHidden()
          await expect(page.locator('.work-time-attention')).toContainText('1 смен')
          assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:shifts[0].id}})).actualEndAt,null)
          await page.getByRole('button',{name:'Разобрать',exact:true}).click()
          await marks.getByLabel('Фактический приход',{exact:true}).fill('09:00')
          await marks.getByLabel('Фактический уход',{exact:true}).fill('18:00')
          await expect(marks.locator('.time-correction-result')).toContainText('Будет подтверждено')
          await shot('full-fact-dialog')
          await marks.getByRole('button',{name:'Сохранить отметки',exact:true}).click()
          await expect(marks).toBeHidden()
          await expect(page.locator('.work-time-attention')).toHaveCount(0)
          await expect(page.locator('.work-time-totals')).toContainText('17 ч 30 мин')
          await page.goto(`${origin}/app/organizations/${org.id}/schedule/work-time?month=2025-10&location=${org.locationId}`)
          await expect(page.locator('.work-time-totals')).toContainText('9 ч')
          await expect(page.locator('.accounting-history-row')).toHaveCount(1)
          for (const width of [320,768]) {
            await page.setViewportSize({width,height:900})
            await fit()
          }
          await page.setViewportSize(viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844})
          await fit();await shot('personal-work-time')
          await page.goto(`${origin}/app/organizations/${org.id}/schedule/statistics?month=2025-10&location=${org.locationId}&report=1`)
          await expect(page).toHaveURL(new RegExp('/schedule/timesheet\\?month=2025-10'))
          await page.getByRole('button', { name: 'Настраиваемые отчёты', exact: true }).click()
          await page.getByRole('button', { name: 'Открыть предпросмотр', exact: true }).click()
          const report = page.getByRole('dialog',{name:'Выгрузка Excel',exact:true})
          await expect(report.locator('.report-metrics')).toContainText('подтверждено')
          await shot('operational-excel')
          await report.getByRole('button', { name: 'Вернуться к табелю', exact: true }).click()
          await expect(report).toBeHidden()
          await page.goto(url)
          await expect(page.locator('.timesheet-checks')).toContainText('Готов к фиксации')
          await expect(page.getByRole('button',{name:'На проверку',exact:true})).toHaveCount(0)
          await expect(page.getByText('Проверяющий',{exact:true})).toHaveCount(0)
          await shot('ready')
          // Change the facts after the user pressed the fixation button. The
          // server must reject the old preview even though its period revision
          // has not changed, and show the refreshed facts before another click.
          const staleClose = async route => {
            if (route.request().postDataJSON()?.action === 'CLOSE') {
              await prisma.workShift.update({where:{id:shifts[1].id},data:{actualEndAt:new Date('2025-10-03T14:45:00Z')}})
              const response = await route.fetch()
              assert.equal(response.status(),409)
              assert.equal((await response.json()).code,'TIMESHEET_DATA_CHANGED')
              await route.fulfill({response})
            } else await route.continue()
          }
          await page.route('**/schedule/timesheets/*/action?*',staleClose)
          await page.getByRole('button',{name:'Зафиксировать и скачать Excel',exact:true}).click()
          await expect(page.locator('.timesheet-page .form-inline-error')).toContainText('Данные изменились после сверки')
          await expect(page.locator('.timesheet-metrics')).toContainText('17 ч 15 мин')
          assert.equal(await prisma.timesheetVersion.count({where:{period:{organizationId:org.id}}}),0)
          await page.unroute('**/schedule/timesheets/*/action?*',staleClose)
          await shot('changed-during-check')
          // Lost response after commit: state reload must show closure, with one
          // version only and without an automatic second write.
          const loseClose = async route => {
            if (route.request().postDataJSON()?.action === 'CLOSE') { const response=await route.fetch();assert(response.ok(),await response.text());await route.abort('failed') }
            else await route.continue()
          }
          await page.route('**/schedule/timesheets/*/action?*',loseClose)
          const firstDownload = page.waitForEvent('download')
          await page.getByRole('button',{name:'Зафиксировать и скачать Excel',exact:true}).click()
          const automaticFile = await firstDownload
          await automaticFile.saveAs(path.join(output,`${viewport}-${theme}-timesheet-v1.xlsx`))
          assert.equal(await automaticFile.failure(),null)
          await expect(page.locator('.timesheet-status')).toContainText('Зафиксирована версия 1')
          await page.unroute('**/schedule/timesheets/*/action?*',loseClose)
          const period=await prisma.timesheetPeriod.findUniqueOrThrow({where:{organizationId_locationId_month:{organizationId:org.id,locationId:org.locationId,month:'2025-10'}}})
          assert.equal(await prisma.timesheetVersion.count({where:{periodId:period.id}}),1)
          const denied=await page.request.post(`${origin}/api/organizations/${org.id}/schedule/shifts/${shifts[0].id}/time-correction?locationId=${org.locationId}`,{headers:{Authorization:authorization,Origin:origin},data:{mode:'NO_SHOW',expectedUpdatedAt:(await prisma.workShift.findUniqueOrThrow({where:{id:shifts[0].id}})).updatedAt.toISOString()}})
          assert.equal(denied.status(),409)
          assert.equal((await denied.json()).code,'TIMESHEET_LOCKED')
          await expect(page.locator('.timesheet-notice')).toHaveCount(0)
          await expect(page.locator('.timesheet-status').getByRole('button',{name:'Скачать Excel · v1',exact:true})).toHaveCount(1)
          await expect(page.locator('.schedule-section-header').getByRole('button',{name:/Excel/})).toHaveCount(0)
          await expect(page.locator('.timesheet-versions').getByRole('button',{name:'Скачать Excel',exact:true})).toHaveCount(0)
          await shot('closed')
          const downloadPromise=page.waitForEvent('download')
          await page.getByRole('button',{name:'Скачать Excel · v1',exact:true}).click()
          const download=await downloadPromise
          await download.saveAs(path.join(output,`${viewport}-${theme}-timesheet-v1.xlsx`))
          assert.equal(await download.failure(),null)
          await page.getByRole('button',{name:'Открыть для исправления',exact:true}).click()
          const dialog=page.getByRole('dialog',{name:'Открыть табель для исправления',exact:true})
          await dialog.getByRole('textbox',{name:'Причина',exact:true}).fill('Уточнение факта после проверки бухгалтерией')
          await shot('reopen-dialog')
          await dialog.getByRole('button',{name:'Открыть табель для исправления',exact:true}).click()
          await expect(dialog).toBeHidden()
          await expect(page.locator('.timesheet-status')).toContainText('Исправление ранее закрытого периода')
          const detail=page.locator('.timesheet-disclosure').first()
          await detail.getByRole('button',{name:/Смены/}).click()
          await detail.getByRole('button',{name:'Исправить время',exact:true}).first().click()
          const correction=page.getByRole('dialog',{name:'Исправить рабочее время',exact:true})
          await correction.getByRole('button',{name:'Не вышел',exact:true}).click()
          await correction.getByRole('textbox').fill('Неявка подтверждена руководителем')
          await correction.getByRole('button',{name:'Сохранить отметки',exact:true}).click()
          await expect(correction).toBeHidden()
          const secondDownload = page.waitForEvent('download')
          await page.getByRole('button',{name:'Зафиксировать и скачать Excel',exact:true}).click()
          assert.equal(await (await secondDownload).failure(),null)
          await expect(page.locator('.timesheet-status')).toContainText('Зафиксирована версия 2')
          await expect(page.getByRole('heading',{name:'Закрытые версии',exact:true})).toBeVisible()
          await expect(page.getByRole('heading',{name:'История периода',exact:true})).toBeVisible()
          await expect(page.locator('.timesheet-version-list').getByRole('button',{name:'Скачать Excel',exact:true})).toHaveCount(1)
          for(const width of viewport==='desktop'?[768,1920]:[320]){await page.setViewportSize({width,height:900});await fit()}
          await page.setViewportSize(viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844})
          await page.reload()
          await expect(page.locator('.timesheet-status')).toContainText('Зафиксирована версия 2')
          await fit()
          await shot('version-2')
          const sick = await prisma.employeeAbsence.findFirstOrThrow({where:{organizationId:org.id,type:'SICK'}})
          const noReason = await page.request.patch(`${origin}/api/organizations/${org.id}/absences/${sick.id}?locationId=${org.locationId}`, {headers:{Authorization:authorization,Origin:origin},data:{startDate:'2025-10-20',endDate:'2025-10-23',updatedAt:sick.updatedAt.toISOString()}})
          assert.equal(noReason.status(),409)
          assert.equal((await noReason.json()).code,'TIMESHEET_REASON_REQUIRED')
          await page.goto(`${origin}/app/organizations/${org.id}/schedule?month=2025-10&location=${org.locationId}&absences=1&absence=${sick.id}`)
          await page.getByRole('button',{name:'Изменить период',exact:true}).click()
          const absenceDialog = page.getByRole('dialog',{name:'Изменить период',exact:true})
          await absenceDialog.getByRole('button',{name:/Последний день/}).click()
          await page.locator('.staffly-calendar [data-date="2025-10-23"]').click()
          await absenceDialog.getByRole('textbox',{name:/Причина изменения/}).fill('Уточнена дата закрытия больничного')
          await shot('absence-correction')
          await absenceDialog.getByRole('button',{name:'Сохранить период',exact:true}).click()
          await expect(page.getByRole('dialog',{name:'Отсутствия команды',exact:true})).toBeVisible()
          await page.goto(url)
          await expect(page.locator('.timesheet-notice')).toContainText('После закрытия данные изменились')
          await shot('late-absence')
          await page.goto(`${origin}/app/organizations/${org.id}/settings?section=requests&location=${org.locationId}`)
          const vacationSettings = page.locator('.vacation-settings')
          await expect(vacationSettings).toBeVisible()
          const holidays = vacationSettings.getByRole('button',{name:/Праздничные дни организации/})
          await holidays.click()
          await expect(holidays).toHaveAttribute('aria-expanded','true')
          await fit()
          await shot('vacation-settings')
          await prisma.organizationSubscription.update({where:{organizationId:org.id},data:{plan:'FREE',trialEndsAt:null}})
          let timesheetReads = 0
          const countReads = request => { if (request.method()==='GET' && /\/api\/organizations\/[0-9a-f-]+\/schedule\/timesheets\//.test(request.url())) timesheetReads++ }
          page.on('request',countReads)
          await page.goto(url)
          await expect(page).toHaveURL(new RegExp(`/app/organizations/${org.id}/schedule\\?`))
          await expect(page.locator('.timesheet-page')).toHaveCount(0)
          assert.equal(timesheetReads,0,'A locked page must not start a timesheet query')
          const blocked = await page.request.get(`${origin}/api/organizations/${org.id}/schedule/timesheets/2025-10?locationId=${org.locationId}`,{headers:{Authorization:authorization}})
          assert.equal(blocked.status(),403)
          const blockedBody=await blocked.json()
          assert.equal(blockedBody.code,'SUBSCRIPTION_FEATURE_REQUIRED')
          assert.equal(blockedBody.errorId,undefined)
          assert.equal(blockedBody.snapshot,undefined)
          assert.equal(blocked.headers()['x-support-code'],undefined)
          const lockedTab=page.getByRole('button',{name:/^Табель/})
          await lockedTab.click()
          const gate=page.getByRole('dialog',{name:'Отчёты и выгрузка в Excel',exact:true})
          await expect(gate).toBeVisible()
          await expect(gate).not.toContainText('Код для поддержки')
          await fit()
          await gate.screenshot({path:path.join(output,`${viewport}-${theme}-tariff-dialog.png`)})
          await gate.getByRole('button',{name:'Закрыть',exact:true}).last().click()
          await expect(gate).toBeHidden()
          // Real refetch on focus and legacy GET refusal must remain silent.
          const otherTab=await context.newPage()
          await otherTab.goto('about:blank')
          await otherTab.bringToFront()
          await page.bringToFront()
          const focusCheck = page.waitForResponse(response => response.url().includes(`/organizations/${org.id}/subscription`) && response.request().method()==='GET' && response.ok())
          await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
          await focusCheck
          await expect(gate).toHaveCount(0)
          const silentCheck = page.waitForResponse(response => response.url().includes(`/organizations/${org.id}/subscription`) && response.request().method()==='GET' && response.ok())
          await page.evaluate(({organizationId})=>{
            window.dispatchEvent(new CustomEvent('staffly:subscription-required',{detail:{organizationId,feature:'timesheets',requiredPlan:'BUSINESS',interactive:false,message:'Ограничение тарифа'}}))
          },{organizationId:org.id})
          await silentCheck
          await expect(gate).toHaveCount(0)
          assert.equal(timesheetReads,0)
          await otherTab.close()
          await prisma.organizationSubscription.update({ where: { organizationId: org.id }, data: { plan: 'TEAM', trialEndsAt: null } })
          await page.goto(url)
          await expect(page.getByRole('heading', { name: 'Табель и отчёты', exact: true })).toBeVisible()
          await expect(page.getByRole('link', { name: 'Табель', exact: true })).toBeVisible()
          await expect(page.getByRole('button', { name: 'Зафиксировать и скачать Excel', exact: true })).toHaveCount(0)
          assert.equal(timesheetReads, 0, 'Team reports must not query Business timesheet snapshots')
          await page.getByRole('button', { name: 'Открыть предпросмотр', exact: true }).click()
          await expect(report.locator('.report-metrics')).toBeVisible()
          await report.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
          await shot('team-reports')
          page.off('request',countReads)
          result.checks.push({theme,viewport,passed:true})
          console.log(`${theme} ${viewport}: timesheet lifecycle, Excel, lost response, locks, correction, downgrade and responsive layout passed`)
        }catch(error){await shot('failure');await writeFile(path.join(output,'timesheet-failure.txt'),await page.locator('body').innerText());throw error}
        finally{await context.close()}
      }
    }
    assert.deepEqual(result.errors,[])
    await writeFile(path.join(output,'timesheet-ui.json'),JSON.stringify(result,null,2))
    return result
  }finally{await browser.close();await server.close()}
}
