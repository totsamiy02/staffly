import assert from 'node:assert/strict'
import {hash} from 'argon2'
import { randomUUID,randomBytes,createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {createServer as socketServer} from 'node:net'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import AxeBuilder from '@axe-core/playwright'
export async function runOrganizationProfiles({prisma,env,root,temporary,output,options,startApi}){
 assert.equal(env.ISOLATED_TEST_CLUSTER,'true');assert(path.resolve(env.LOCAL_STORAGE_ROOT).startsWith(path.resolve(temporary)+path.sep))
 process.env.PLAYWRIGHT_BROWSERS_PATH??=path.join(root,'artifacts/browser-binaries')
 const {chromium,expect}=await import('playwright/test')
 const socket=socketServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
 const origin='http://127.0.0.1:'+port;env.APP_ORIGIN=origin;env.RUN_BACKGROUND_WORKERS='false'
 const api=await startApi(),{devApiProxy}=await import('../../scripts/dev-api-proxy.ts')
 const harness={name:'profile-error-harness',configureServer(server){server.middlewares.use('/__profile-error',async(_q,s,next)=>{try{s.setHeader('Content-Type','text/html');s.end(await server.transformIndexHtml('/__profile-error','<html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Проверка ошибки</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/tests/interface/profile-error-harness.tsx"></script></body></html>'))}catch(e){next(e)}})}}
 const vite=await createServer({configFile:false,root,cacheDir:path.join(temporary,'vite-cache'),plugins:[react(),devApiProxy(Number(new URL(api).port)),harness],server:{host:'127.0.0.1',port,strictPort:true,watch:{ignored:['**/artifacts/**','**/docs/**','**/src/server/**','**/src/generated/**']}},logLevel:'error'});await vite.listen()
 const theme=options.theme??'light',report={theme,checks:[],errors:[]},save=()=>writeFile(path.join(output,'organization-profiles.json'),JSON.stringify(report,null,2))
 const passwordHash=await hash('Staffly-profile-acceptance-2026!')
 const browser=await chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined})
 try{for(const viewport of ['desktop','mobile']){
  const owner=await prisma.user.create({data:{email:randomUUID()+'@example.test',emailVerifiedAt:new Date(),passwordHash,firstName:'Тестовый владелец'}})
  const context=await browser.newContext({viewport:viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'})
  await context.addInitScript(theme=>{localStorage.setItem('staffly.theme',theme);localStorage.setItem('staffly-cookie-consent','necessary')},theme)
  const token=randomUUID()+randomUUID(),browserToken=randomBytes(48).toString('base64url');await prisma.authSession.create({data:{userId:owner.id,browserTokenHash:createHash('sha256').update(browserToken).digest('hex'),refreshTokenHash:createHash('sha256').update(token).digest('hex'),idleExpiresAt:new Date(Date.now()+3600000),absoluteExpiresAt:new Date(Date.now()+3600000)}})
  await context.addCookies(['staffly_refresh','staffly_browser'].map(name=>({name,value:name==='staffly_refresh'?token:browserToken,domain:'127.0.0.1',path:'/api/auth',httpOnly:true,sameSite:'Lax'})))
  const page=await context.newPage();let authorization;page.on('request',request=>{if(request.headers().authorization)authorization=request.headers().authorization});let intentional=false;page.on('pageerror',e=>{if(!intentional)report.errors.push(e.message)})
  const check=async(name,run)=>{try{await run();report.checks.push({viewport,name,passed:true});await save();console.log(viewport+': '+name)}catch(e){await page.screenshot({path:path.join(output,viewport+'-failure.png'),fullPage:true});await writeFile(path.join(output,viewport+'-failure.txt'),await page.locator('body').innerText());throw e}}
  const shot=async name=>{await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,viewport+'-'+theme+'-'+name+'.png'),fullPage:true})}
  const fit=async()=>{await page.evaluate(()=>document.fonts.ready);const size=await page.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));assert(size.s<=size.w+1,JSON.stringify(size))}
  const select=async(label,option)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click()}
  const name='Профиль '+randomUUID().slice(0,8);let org
  if(String(options['error-only'])!=='true'){
  await check('creation matches organization and point form, uses custom controls and preserves a failed submission',async()=>{
   await page.goto(origin+'/app');await page.getByRole('link',{name:'Создать организацию',exact:false}).click();await expect(page.getByRole('heading',{name:'Создание организации',exact:true})).toBeVisible()
   await page.getByRole('textbox',{name:'Название организации *',exact:true}).fill(name);await page.getByRole('textbox',{name:'Описание',exact:true}).fill('Синтетическое описание организации');await page.getByRole('textbox',{name:'Сфера деятельности',exact:true}).fill('Синтетическая сфера')
   await page.getByRole('button',{name:'Контакты и адрес',exact:false}).click();await page.getByRole('textbox',{name:'Рабочая почта',exact:true}).fill('org@example.test');await page.getByRole('textbox',{name:'Сайт',exact:true}).fill('https://example.test');await page.getByRole('textbox',{name:'Адрес организации',exact:true}).fill('Синтетический адрес организации')
   await page.locator('input[type=file]').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')})
   await page.getByRole('button',{name:'Удалённо',exact:true}).click();await expect(page.getByRole('textbox',{name:'Город *',exact:true})).toHaveCount(0)
   await page.getByRole('button',{name:'Подробнее о точке',exact:false}).click();await page.getByRole('textbox',{name:'Описание для сотрудников',exact:true}).fill('Синтетическая инструкция для сотрудников')
   const pointName=await page.getByRole('textbox',{name:'Название точки *',exact:true}).boundingBox(),extra=await page.locator('.organization-create-additional').boundingBox();assert(pointName.y+pointName.height<=extra.y);
   await page.getByRole('button',{name:'Часы работы',exact:false}).click();await select('Режим Пн','Рабочий день');await page.getByRole('button',{name:'Часы работы',exact:false}).click();await page.getByRole('button',{name:'Создать организацию',exact:true}).click();await expect(page.getByRole('textbox',{name:'Открытие Пн',exact:true})).toBeVisible();await page.getByRole('textbox',{name:'Открытие Пн',exact:true}).fill('09:00');await page.getByRole('textbox',{name:'Закрытие Пн',exact:true}).fill('18:00')
   await page.getByRole('button',{name:'Скопировать часы на другие дни',exact:true}).click();await page.locator('.hours-copy__days').getByRole('checkbox',{name:'Среда',exact:true}).uncheck();await page.locator('.hours-copy__days').getByRole('checkbox',{name:'Четверг',exact:true}).uncheck();await page.locator('.hours-copy__days').getByRole('checkbox',{name:'Пятница',exact:true}).uncheck();await page.locator('.hours-copy__days').getByRole('checkbox',{name:'Суббота',exact:true}).check();await page.getByRole('button',{name:'Скопировать',exact:true}).click();await expect(page.getByRole('combobox',{name:'Режим Вт',exact:true})).toContainText('Рабочий день');await expect(page.getByRole('combobox',{name:'Режим Ср',exact:true})).toContainText('Не заданы');await expect(page.getByRole('combobox',{name:'Режим Сб',exact:true})).toContainText('Рабочий день');
   await fit();assert.equal(await page.locator('input[type=time]').count(),0);assert(await page.getByRole('combobox').count()>0);await shot('create')
   const rejected=async route=>{if(route.request().method()==='POST')await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Проверьте сведения организации.'})});else await route.continue()}
   await page.route('**/api/organizations',rejected);await page.getByRole('button',{name:'Создать организацию',exact:true}).click();await expect(page.locator('.organization-create-footer [role=alert]')).toContainText('Проверьте сведения');await expect(page.getByRole('textbox',{name:'Название организации *',exact:true})).toBeEnabled();await page.unroute('**/api/organizations',rejected)
   const lost=async route=>{if(route.request().method()==='POST'){const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed')}else await route.continue()}
   await page.route('**/api/organizations',lost);await page.getByRole('button',{name:'Создать организацию',exact:true}).click();await expect(page.locator('.organization-create-footer [role=alert]')).toBeVisible();await expect(page.getByRole('textbox',{name:'Название организации *',exact:true})).toHaveValue(name)
   await page.unroute('**/api/organizations',lost);await page.getByRole('button',{name:'Повторить создание',exact:true}).click();await expect(page.getByRole('heading',{name:'Профиль организации',exact:true})).toBeVisible()
   assert.equal(await prisma.organization.count({where:{createdByUserId:owner.id}}),1);org=await prisma.organization.findFirstOrThrow({where:{createdByUserId:owner.id}});assert(org.logoFileId);assert.equal(org.industry,'Синтетическая сфера')
  })
  await check('profile, edit, info dialog and organization card read the same saved data',async()=>{
   await expect(page.locator('.organization-profile-editor')).toContainText('Синтетическая сфера');await fit();await shot('profile')
   await page.getByRole('button',{name:'Редактировать',exact:true}).click();await page.getByRole('textbox',{name:'Сфера деятельности',exact:true}).fill('Обновлённая сфера');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('button',{name:'Редактировать',exact:true})).toBeEnabled();await expect(page.locator('.organization-profile-editor')).toContainText('Обновлённая сфера')
   await page.getByRole('button',{name:'Об организации: '+name,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Об организации',exact:true});await expect(dialog).toContainText('Обновлённая сфера');await expect(dialog).toContainText('org@example.test');await fit();await shot('info');await dialog.getByRole('button',{name:'Закрыть',exact:true}).click()
   await page.goto(origin+'/app');await expect(page.locator('.organization-card').filter({hasText:name})).toContainText('Обновлённая сфера')
  })
  await check('point details, remote state and hours are visible and edits preserve server revision',async()=>{
   await page.goto(origin+'/app/organizations/'+org.id+'/settings?section=locations');const point=page.locator('.location-settings-item').first();await point.getByRole('button',{name:'Подробнее о точке',exact:false}).click();await expect(point).toContainText('Синтетическая инструкция для сотрудников');await expect(point).toContainText('09:00 — 18:00');await expect(point).toContainText('Без физического адреса');await fit();await shot('point')
   await point.getByRole('button',{name:'Изменить',exact:true}).click();const form=page.getByRole('dialog',{name:'Данные точки',exact:true});await form.getByRole('textbox',{name:'Название точки *',exact:true}).fill('Новая точка');await form.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(form).toBeHidden();assert.equal((await prisma.organizationLocation.findFirstOrThrow({where:{organizationId:org.id}})).name,'Новая точка')
   const accessibility=await new AxeBuilder({page}).include('.settings-page').withTags(['wcag2a','wcag2aa']).analyze();assert.deepEqual(accessibility.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[])
   if(viewport==='mobile'){await page.setViewportSize({width:320,height:740});await fit();await page.setViewportSize({width:390,height:844})}
  })
  await check('Free shows a tariff explanation instead of the second-point form and HTTP refuses creation',async()=>{
   await page.goto(origin+'/app/organizations/'+org.id+'/settings?section=locations');await page.getByRole('button',{name:'Добавить точку',exact:true}).click();const gate=page.getByRole('dialog',{name:'Больше точек для бизнеса',exact:true});await expect(gate).toContainText('Лимит достигнут');await expect(page.getByRole('dialog',{name:'Новая точка',exact:true})).toHaveCount(0);await gate.getByRole('button',{name:'Закрыть',exact:true}).click()
   const denied=await page.request.post(origin+'/api/organizations/'+org.id+'/locations',{headers:{Origin:origin,Authorization:authorization},data:{name:'Вторая точка',kind:'REMOTE',timezone:'Europe/Moscow'}});assert.equal(denied.status(),409);assert.equal(await prisma.organizationLocation.count({where:{organizationId:org.id}}),1)
  })
  await check('a shift outside opening hours requires a fresh explicit confirmation',async()=>{
   const point=await prisma.organizationLocation.findFirstOrThrow({where:{organizationId:org.id}}),date=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})+'T12:00:00Z');do{date.setUTCDate(date.getUTCDate()+1)}while(date.getUTCDay()!==1);const day=date.toISOString().slice(0,10)
   await page.goto(origin+'/app/organizations/'+org.id+'/schedule?location='+point.id+'&month='+day.slice(0,7));await page.getByRole('button',{name:/Добавить смену/}).first().click();const dialog=page.getByRole('dialog',{name:'Создать смену',exact:true});await dialog.getByRole('combobox',{name:'Сотрудник',exact:true}).click();await page.getByRole('option',{name:/Тестовый владелец/}).click()
   for(const group of ['Начало смены','Окончание смены']){const field=dialog.getByRole('group',{name:group,exact:true});await field.getByRole('button',{name:/^Дата/}).click();const calendar=page.getByRole('dialog',{name:'Выбор даты',exact:true});await expect(calendar).toBeVisible();if(!await calendar.locator('[data-date="'+day+'"]').count())await calendar.getByRole('button',{name:'Следующий месяц',exact:true}).click();await calendar.locator('[data-date="'+day+'"]').click();await field.getByRole('textbox',{name:'Время',exact:true}).fill(group==='Начало смены'?'08:00':'19:00')}
   const save=dialog.getByRole('button',{name:'Создать смену',exact:true}),confirmation=dialog.getByRole('checkbox',{name:'Подтверждаю назначение смен за пределами часов работы точки',exact:true});await save.click();await expect(dialog.locator('[role=alert]')).toContainText('09:00');await expect(confirmation).toBeVisible();await expect(save).toBeDisabled();assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),0)
   await fit();await shot('shift-warning')
   await dialog.getByRole('group',{name:'Окончание смены',exact:true}).getByRole('textbox',{name:'Время',exact:true}).fill('17:00');await expect(confirmation).toHaveCount(0);await save.click();await expect(confirmation).toBeVisible();await confirmation.check();await save.click();await expect(dialog).toBeHidden();assert.equal(await prisma.workShift.count({where:{organizationId:org.id}}),1)
  })
  await check('opening hours can be changed in point settings without changing existing shifts',async()=>{
   const before=await prisma.workShift.findFirstOrThrow({where:{organizationId:org.id}})
   await page.goto(origin+'/app/organizations/'+org.id+'/settings?section=locations');await page.locator('.location-settings-item').first().getByRole('button',{name:'Изменить',exact:true}).click();const form=page.getByRole('dialog',{name:'Данные точки',exact:true});await form.getByRole('textbox',{name:'Закрытие Пн',exact:true}).fill('16:00');await fit();await shot('edit-hours');await form.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(form).toBeHidden()
   const point=await prisma.organizationLocation.findFirstOrThrow({where:{organizationId:org.id}});assert.equal(point.openingHours.find(d=>d.day===0).end,'16:00');const after=await prisma.workShift.findUniqueOrThrow({where:{id:before.id}});assert.equal(after.scheduledStartAt.toISOString(),before.scheduledStartAt.toISOString());assert.equal(after.scheduledEndAt.toISOString(),before.scheduledEndAt.toISOString())
  })
  }
  await check('500 boundary support reference remains readable and fits the screen',async()=>{
   intentional=true;await page.route('**/api/support/client-errors',route=>route.fulfill({status:202,contentType:'application/json',body:'{}'}));await page.goto(origin+'/__profile-error?theme='+theme);await expect(page.getByRole('heading',{name:'Не удалось открыть страницу',exact:true})).toBeVisible();await expect(page.locator('.copy-reference')).toBeVisible();await fit();const font=await page.locator('.request-error-reference').evaluate(e=>parseFloat(getComputedStyle(e).fontSize));assert(font<=14);assert((await page.getByRole('button',{name:'Обновить',exact:true}).boundingBox()).height>=40);assert((await page.locator('main').evaluate(e=>getComputedStyle(e).fontFamily)).includes('Arial'));await shot('error')
  })
  await context.close()
 }}finally{await browser.close();await vite.close()}
 assert.deepEqual(report.errors,[]);report.status='passed';await save();return report
}
