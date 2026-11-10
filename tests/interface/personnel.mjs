import AxeBuilder from '@axe-core/playwright'
import { hash } from 'argon2'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer as socketServer } from 'node:net'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

export async function runPersonnel({ prisma, env, root, output, options, temporary, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER,'true','Personnel acceptance requires the disposable cluster runner')
  assert.equal(env.NODE_ENV,'test')
  assert(path.resolve(env.LOCAL_STORAGE_ROOT).startsWith(path.resolve(temporary)+path.sep),'Use disposable storage only')
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root,'artifacts/browser-binaries')
  const { chromium, expect } = await import('playwright/test')
  const { createOrganization } = await import('../../src/server/organizations/organization-service.ts')
  const theme=options.theme??'light';assert(['light','dark'].includes(theme))
  const socket=socketServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
  const origin='http://127.0.0.1:'+port;env.APP_ORIGIN=origin;env.RUN_BACKGROUND_WORKERS='false'
  const api=await startApi(),{devApiProxy}=await import('../../scripts/dev-api-proxy.ts')
  const server=await createServer({configFile:false,root,plugins:[react(),devApiProxy(Number(new URL(api).port))],server:{host:'127.0.0.1',port,strictPort:true,watch:{ignored:['**/artifacts/**','**/storage/**','**/docs/**','**/src/server/**','**/src/generated/**']}},logLevel:'error'})
  await server.listen()
  const result={status:'running',theme,checks:[],errors:[],screenshots:[]}
  const save=()=>writeFile(path.join(output,'personnel.json'),JSON.stringify(result,null,2))
  const passwordHash=await hash('Personnel-acceptance-test-2026!')
  const browser=await chromium.launch({executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,headless:true})
  try{
    for(const viewport of ['desktop','mobile']){
      const suffix=randomUUID(),contexts=[],pages=[],tokens=new Map()
      const people=await Promise.all(['Владелец','Руководитель','Сотрудник','Посторонний'].map(firstName=>prisma.user.create({data:{email:firstName.length+'-'+randomUUID()+'@example.test',firstName,passwordHash,emailVerifiedAt:new Date()}})))
      const [owner,manager,employee,outsider]=people
      const org=await createOrganization(owner.id,{name:'Кадровая приёмка '+suffix,description:null,timezone:'Europe/Moscow'})
      const base='/app/organizations/'+org.id,location='?location='+org.locationId
      const managerMember=await prisma.organizationMember.create({data:{organizationId:org.id,userId:manager.id}})
      await prisma.locationMember.create({data:{organizationId:org.id,memberId:managerMember.id,locationId:org.locationId,role:'ADMIN'}})
      const foreign=await createOrganization(outsider.id,{name:'Другой контур '+suffix,description:null,timezone:'Europe/Moscow'})
      for(const person of [owner,manager,employee]){
        const context=await browser.newContext({viewport:viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'})
        contexts.push(context)
        await context.addInitScript(theme=>{localStorage.setItem('staffly.theme',theme);localStorage.setItem('staffly-cookie-consent','necessary')},theme)
        const token=randomUUID()+randomUUID();await prisma.authSession.create({data:{userId:person.id,refreshTokenHash:createHash('sha256').update(token).digest('hex'),idleExpiresAt:new Date(Date.now()+3600000),absoluteExpiresAt:new Date(Date.now()+3600000)}})
        await context.addCookies([{name:'staffly_refresh',value:token,domain:'127.0.0.1',path:'/api/auth',httpOnly:true,sameSite:'Lax'}])
        const page=await context.newPage();pages.push(page);page.on('request',request=>{const authorization=request.headers().authorization;if(authorization)tokens.set(page,authorization)});page.on('pageerror',error=>result.errors.push({viewport,error:error.message}))
      }
      const [op,mp,ep]=pages
      const check=async(name,run)=>{try{await run();result.checks.push({viewport,name,passed:true});await save();console.log(viewport+': '+name)}catch(error){result.checks.push({viewport,name,passed:false,error:error.message});for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:path.join(output,viewport+'-failure-'+i+'.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(output,viewport+'-failure-'+i+'.txt'),await pages[i].locator('body').innerText().catch(()=>''))}await save();throw error}}
      const select=async(page,label,text,host=page)=>{await host.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:text}).click()}
      const invite=async()=>{
        await op.goto(origin+base+'/employees'+location);await op.getByRole('button',{name:'Пригласить сотрудника',exact:true}).click()
        const dialog=op.getByRole('dialog',{name:'Пригласить сотрудника',exact:true});await dialog.getByRole('tab',{name:'По коду',exact:true}).click();await dialog.getByRole('button',{name:'Создать код',exact:true}).click();await expect(dialog.locator('.generated-code')).toBeVisible();const code=await dialog.locator('.generated-code').innerText()
        await dialog.getByRole('button',{name:'Закрыть',exact:true}).click()
        await ep.goto(origin+'/app');await ep.getByPlaceholder('XXXX-XXXX-XXXX').fill(code);await ep.getByRole('button',{name:'Проверить код',exact:true}).click();await ep.getByRole('button',{name:'Присоединиться',exact:true}).click();await expect(ep.locator('.organization-card').filter({hasText:org.name})).toBeVisible()
      }
      let member,shift,document
      try{
        await check('owner invites and employee accepts a one-use code',async()=>{await invite();member=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org.id,userId:employee.id}}});assert.equal(member.role,'MEMBER')})
        await check('owner selects and renews tariffs without payment; lost response does not duplicate renewal',async()=>{
          await op.goto(origin+base+'/settings?section=subscription');await expect(op.getByRole('heading',{name:'Тариф и использование',exact:true})).toBeVisible();await expect(op.locator('main:not(.app-loading):not(.route-loading)').first()).toContainText('Владелец каждой организации может выбрать и подключить тариф здесь, без оплаты');assert.equal(await op.locator('input[name=number],input[name=cvc],input[name=holder]').count(),0)
          await op.getByRole('button',{name:'Подключить Команду',exact:true}).click()
          const dialog=op.getByRole('dialog',{name:'Подключить тариф без оплаты?',exact:true})
          const lost=async route=>{const response=await route.fetch();assert(response.ok());await route.abort('failed')}
          await op.route('**/api/organizations/*/subscription/select*',lost);await dialog.getByRole('button',{name:'Подтвердить без оплаты',exact:true}).click();await expect(dialog.locator('[role=alert]')).toBeVisible();const initial=await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}});assert.equal(initial.plan,'TEAM')
          await op.unroute('**/api/organizations/*/subscription/select*',lost);await dialog.getByRole('button',{name:'Подтвердить без оплаты',exact:true}).click();await expect(dialog).toBeHidden()
          assert.equal(+(await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}})).periodEnd,+initial.periodEnd)
          assert.equal(await prisma.accessAudit.count({where:{organizationId:org.id,action:'SUBSCRIPTION_PLAN_SELECTED'}}),1)
          await op.getByRole('button',{name:'Продлить без оплаты',exact:true}).click();const renewal=op.getByRole('dialog',{name:'Продлить тариф без оплаты?',exact:true});await renewal.getByRole('button',{name:'Подтвердить без оплаты',exact:true}).click();await expect(renewal).toBeHidden();assert(+(await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}})).periodEnd>+initial.periodEnd)
          for(const [button,plan] of [['Подключить Бизнес','BUSINESS'],['Выбрать Бесплатный','FREE']]){await op.getByRole('button',{name:button,exact:true}).click();const confirm=op.getByRole('dialog');await confirm.getByRole('button',{name:'Подтвердить без оплаты',exact:true}).click();await expect(confirm).toBeHidden();assert.equal((await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}})).plan,plan)}
          assert.equal(await prisma.subscriptionPurchase.count({where:{organizationId:org.id}}),0)
        })
        await check('manager creates a shift and employee sees own schedule without edit controls',async()=>{
          await mp.goto(origin+base+'/schedule'+location);await mp.getByRole('button',{name:/Добавить смену/}).first().click()
          const denied=await mp.request.post(origin+'/api/organizations/'+org.id+'/subscription/select',{headers:{Authorization:tokens.get(mp)},data:{plan:'BUSINESS',revision:(await prisma.organizationSubscription.findUniqueOrThrow({where:{organizationId:org.id}})).revision,confirm:true}});assert.equal(denied.status(),403)
          const dialog=mp.getByRole('dialog',{name:'Создать смену',exact:true});await select(mp,'Сотрудник',new RegExp('Сотрудник'),dialog)
          const yesterday=new Date(Date.now()-86400000),day=yesterday.toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})
          for(const group of ['Начало смены','Окончание смены']){const field=dialog.getByRole('group',{name:group,exact:true});await field.getByRole('button',{name:/^Дата/}).click();const calendar=mp.getByRole('dialog',{name:'Выбор даты',exact:true});await expect(calendar).toBeVisible();if(!await calendar.locator('[data-date="'+day+'"]').count())await calendar.getByRole('button',{name:'Предыдущий месяц',exact:true}).click();await calendar.locator('[data-date="'+day+'"]').click();await field.getByRole('textbox',{name:'Время',exact:true}).fill(group==='Начало смены'?'06:00':'14:00')}
          await dialog.getByRole('textbox',{name:'Комментарий к смене',exact:true}).fill('Приёмка '+suffix);await dialog.getByRole('button',{name:'Создать смену',exact:true}).click();await expect(dialog).toBeHidden();shift=await prisma.workShift.findFirstOrThrow({where:{organizationId:org.id,memberId:member.id}})
          await ep.goto(origin+base+'/schedule'+location);await expect(ep.locator('main:not(.app-loading):not(.route-loading)').first()).toContainText('Расписание');await expect(ep.getByRole('button',{name:/Добавить смену/})).toHaveCount(0)
        })
        await check('employee request survives a network error and is submitted once',async()=>{
          await ep.goto(origin+base+'/requests'+location+'&tab=mine');await ep.getByRole('button',{name:'Создать заявку',exact:true}).first().click();await ep.locator('.request-type-choice-list button').filter({has:ep.getByText('Другое',{exact:true})}).click()
          const form=ep.locator('.request-form-dialog');await form.getByPlaceholder('Опишите детали заявки').fill('Кадровая заявка '+suffix)
          const fail=route=>route.request().method()==='POST'?route.fulfill({status:503,json:{code:'API_UNAVAILABLE',message:'Временная недоступность для приёмки'}}):route.continue()
          await ep.route('**/api/organizations/*/requests*',fail);await form.getByRole('button',{name:'Отправить заявку',exact:true}).click();await expect(form).toContainText('Сервис временно недоступен');await expect(form.getByPlaceholder('Опишите детали заявки')).toHaveValue('Кадровая заявка '+suffix);await ep.unroute('**/api/organizations/*/requests*',fail)
          await form.getByRole('button',{name:'Отправить заявку',exact:true}).click();await expect(form).toBeHidden();assert.equal(await prisma.organizationRequest.count({where:{organizationId:org.id,createdByMemberId:member.id}}),1)
          await mp.goto(origin+base+'/requests'+location+'&tab=incoming');await expect(mp.locator('.request-row').first()).toBeVisible();await mp.locator('.request-row .staffly-action-surface__open').first().click();await mp.getByRole('button',{name:'Рассмотреть заявку',exact:true}).click();const review=mp.getByRole('dialog',{name:'Рассмотреть заявку',exact:true});await review.getByRole('button',{name:'Сохранить решение',exact:true}).click();await expect(review).toBeHidden();assert.equal((await prisma.organizationRequest.findFirstOrThrow({where:{organizationId:org.id,createdByMemberId:member.id}})).status,'APPROVED')
        })
        await check('manager uploads a document and assigns employee acknowledgement',async()=>{
          await mp.goto(origin+base+'/documents'+location);await mp.getByRole('button',{name:'Загрузить документ',exact:true}).first().click()
          const form=mp.getByRole('dialog',{name:'Загрузить документ',exact:true});await form.locator('input[type=file]').setInputFiles({name:'acceptance.txt',mimeType:'text/plain',buffer:Buffer.from('Синтетический документ кадровой приёмки.')});await form.getByRole('textbox',{name:'Название',exact:true}).fill('Инструкция '+suffix);await form.getByRole('checkbox',{name:'Назначить обязательное ознакомление после загрузки',exact:true}).check();await form.getByRole('button',{name:'Загрузить и продолжить',exact:true}).click()
          const assign=mp.getByRole('dialog',{name:'Получатели ознакомления',exact:true});await assign.getByRole('checkbox',{name:'Выбрать: Сотрудник',exact:true}).check();await assign.locator('footer button.app-primary').click();await expect(assign).toBeHidden();document=await prisma.document.findFirstOrThrow({where:{organizationId:org.id,displayName:'Инструкция '+suffix}})
        })
        await check('employee opens the document and explicitly acknowledges it',async()=>{
          await ep.goto(origin+base+'/documents'+location);await ep.locator('.document-row__name').filter({hasText:'Инструкция '+suffix}).click();await ep.getByRole('button',{name:'Подтвердить ознакомление',exact:true}).click();await expect(ep.locator('.document-viewer-own-ack')).toContainText('Подтверждено');assert((await prisma.documentAcknowledgement.findFirstOrThrow({where:{documentId:document.id,memberId:member.id}})).acknowledgedAt)
        })
        await check('employee is denied managerial archive and foreign organization access',async()=>{
          const denied=await ep.request.get(origin+'/api/organizations/'+org.id+'/members?state=former',{headers:{Authorization:tokens.get(ep)}});assert.equal(denied.status(),403)
          await ep.goto(origin+base+'/employees'+location+'&tab=archive');await expect(ep.getByRole('button',{name:'Архив сотрудников',exact:true})).toHaveCount(0)
          const foreignDenied=await ep.request.get(origin+'/api/organizations/'+foreign.id+'/members?state=former',{headers:{Authorization:tokens.get(ep)}});assert.equal(foreignDenied.status(),404)
          await ep.goto(origin+'/app/organizations/'+foreign.id+'/employees');await expect(ep.locator('main:not(.app-loading):not(.route-loading)').first()).toContainText(/Организация не найдена|Нет доступа|Недостаточно прав/)
        })
        await check('owner excludes employee despite a lost response; archive and history remain',async()=>{
          // Synthetic pre-existing elevated role proves that rehire does not restore it.
          await prisma.locationMember.update({where:{locationId_memberId:{locationId:org.locationId,memberId:member.id}},data:{role:'ADMIN'}})
          await op.goto(origin+base+'/employees'+location);const row=op.locator('.member-row').filter({hasText:employee.email});await row.getByRole('button',{name:'Действия с сотрудником Сотрудник',exact:true}).click();await row.getByRole('button',{name:'Удалить из организации',exact:true}).click()
          const dialog=op.locator('.member-departure');const lost=async route=>{if(route.request().method()==='POST'){const response=await route.fetch();assert(response.ok());await route.abort('failed')}else await route.continue()}
          await op.route('**/api/organizations/*/members/*/departure?*',lost);await dialog.getByRole('button',{name:'Исключить сотрудника',exact:true}).click();await expect(dialog.locator('[role=alert]')).toBeVisible();await op.unroute('**/api/organizations/*/members/*/departure?*',lost)
          await op.goto(origin+base+'/employees'+location+'&tab=archive');await expect(op.getByRole('heading',{name:'Архив сотрудников',exact:true})).toBeVisible();const card=op.locator('.member-archive-card').filter({hasText:employee.email});await expect(card).toBeVisible();await card.getByText('Периоды работы',{exact:true}).click();assert.deepEqual((await new AxeBuilder({page:op}).include('.members-page').analyze()).violations,[]);const archiveShot=viewport+'-'+theme+'-archive.png';await op.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await op.screenshot({path:path.join(output,archiveShot),fullPage:true});result.screenshots.push(archiveShot);await card.getByRole('button',{name:'Рабочая история',exact:true}).click();await expect(op.locator('.member-profile-dialog')).toBeVisible();await op.keyboard.press('Escape')
          assert((await prisma.organizationMember.findUniqueOrThrow({where:{id:member.id}})).leftAt);assert.equal((await prisma.workShift.findUniqueOrThrow({where:{id:shift.id}})).memberId,member.id)
          await ep.goto(origin+base+'/documents'+location);await expect(ep.locator('main:not(.app-loading):not(.route-loading)').first()).toContainText(/Организация не найдена|Нет доступа/)
        })
        await check('rehire preserves identity, periods and acknowledgement without restoring old powers',async()=>{
          await invite();const returned=await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org.id,userId:employee.id}}});assert.equal(returned.id,member.id);assert.equal(returned.leftAt,null);assert.equal(await prisma.memberEmploymentPeriod.count({where:{memberId:member.id}}),2);assert((await prisma.documentAcknowledgement.findFirstOrThrow({where:{documentId:document.id,memberId:member.id}})).acknowledgedAt)
          await ep.goto(origin+base+'/schedule'+location);await expect(ep.locator('main:not(.app-loading):not(.route-loading)').first()).toContainText('Расписание');await expect(ep.getByRole('button',{name:/Добавить смену/})).toHaveCount(0)
          const placement=await prisma.locationMember.findUniqueOrThrow({where:{locationId_memberId:{locationId:org.locationId,memberId:member.id}}});assert.equal(placement.role,'MEMBER');assert.equal(await prisma.accessAssignment.count({where:{memberId:member.id}}),0)
          await op.goto(origin+base+'/employees'+location+'&tab=archive');await expect(op.locator('.member-archive-card').filter({hasText:employee.email})).toHaveCount(0)
        })
        await check('all three role interfaces fit the mobile and desktop viewport in the selected theme',async()=>{
          for(const page of pages){assert.equal(await page.locator('html').getAttribute('data-theme'),theme);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2))}
          await op.goto(origin+base+'/settings?section=subscription');await expect(op.getByRole('heading',{name:'Тариф и использование',exact:true})).toBeVisible();assert.deepEqual((await new AxeBuilder({page:op}).include('.subscription-settings').analyze()).violations,[]);const file=viewport+'-'+theme+'-access.png';await op.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await op.screenshot({path:path.join(output,file),fullPage:true});result.screenshots.push(file)
        })
      }finally{for(const context of contexts)await context.close()}
    }
    assert.equal(result.checks.length,20,'Every mandatory personnel scenario must execute in both viewports')
    assert.equal(result.errors.length,0,JSON.stringify(result.errors));result.status='passed';await save();return result
  }catch(error){result.status='failed';result.errors.push({message:error.message});await save();throw error}
  finally{await browser.close();await server.close()}
}
