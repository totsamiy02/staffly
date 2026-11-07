import assert from 'node:assert/strict'
import { createServer as netServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'

// The actual admin router and authentication run against the runner's temporary
// database. A test-only injected mail delivery captures synthetic codes in memory.
// There is no test code endpoint, auth bypass, working .env or external SMTP.
export async function runAdminInterface({prisma,env,root,temporary,output,options}){
 const socket=netServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve))
 const origin=`http://127.0.0.1:${port}`;env.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin
 const [{default:express},{default:cookieParser},{default:authRouter},{createAdminRouter},{default:profileRouter},{ApiError},{ZodError},{passwordHash},{databasePool},{createBusinessOrganization},{collectMonitoringSample,recordOrganizationPresence},{closeAdminDatabase}]=await Promise.all([
  import('express'),import('cookie-parser'),import('../../src/server/auth.ts'),import('../../src/server/admin/routes.ts'),import('../../src/server/profile/routes.ts'),import('../../src/server/api-error.ts'),import('zod'),import('../../src/server/auth/passwords.ts'),import('../../src/server/db.ts'),import('../support/business-organization.ts'),import('../../src/server/admin/collection.ts'),import('../../src/server/admin/database.ts'),
 ])
 const codes=new Map(),password='StafflyAdminUi-93!',pin='628491',hash=await passwordHash(password)
 const {default:organizationRouter}=await import('../../src/server/organizations/routes.ts')
 const {default:storageRouter}=await import('../../src/server/storage/routes.ts')
 const {replaceUserAvatar}=await import('../../src/server/storage/image-service.ts')
 const app=express();app.use(express.json());app.use(cookieParser());app.use('/api/auth',authRouter);app.use('/api/admin',createAdminRouter({sendCode:async(email,code)=>{codes.set(email,code)},sendNotice:async()=>{}}));app.use('/api',profileRouter);app.use('/api',organizationRouter);app.use('/api',storageRouter)
 app.use((error,_q,response,_next)=>response.status(error instanceof ApiError?error.status:error instanceof ZodError?400:500).json({code:error instanceof ApiError?error.code:'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'Не удалось выполнить действие.'}))
 const api=app.listen(0,'127.0.0.1');await new Promise(resolve=>api.once('listening',resolve));const apiPort=api.address().port
 const {devApiProxy}=await import('../../scripts/dev-api-proxy.ts')
 const vite=await createServer({configFile:false,root,plugins:[react(),devApiProxy(apiPort)],server:{host:'127.0.0.1',port,strictPort:true,watch:{ignored:['**/artifacts/**','**/storage/**','**/docs/**','**/src/server/**','**/src/generated/**']}},logLevel:'error'})
 await vite.listen()
 process.env.PLAYWRIGHT_BROWSERS_PATH??=path.join(root,'artifacts/browser-binaries')
 const {chromium,firefox,webkit,expect}=await import('playwright/test')
 const firefoxHome=path.join(temporary,'admin-firefox');await mkdir(firefoxHome,{recursive:true})
 const launch={chrome:()=>chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined}),firefox:async()=>{const home=path.join(firefoxHome,randomUUID());await mkdir(home,{recursive:true});return firefox.launch({headless:true,env:{...process.env,CFFIXED_USER_HOME:home}})},webkit:()=>webkit.launch({headless:true})}
 const result={checks:[],errors:[],screenshots:[]}
 try{
  for(const name of(options.browsers??'chrome').split(',')){
    for(const viewport of(options.viewports??'desktop,mobile').split(',')){
   const browser=await launch[name]()
   try{
     let activePin=pin,activeCheck=''
     const tag=`${name}-${viewport}`,email=`admin-ui-${randomUUID()}@example.test`,user=await prisma.user.create({data:{email,passwordHash:hash,emailVerifiedAt:new Date(),firstName:'Алексей',lastName:'Власов'}})
     await replaceUserAvatar(user.id,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'))
     await databasePool.query('INSERT INTO staffly_admin.accounts(user_id) VALUES($1)',[user.id])
     const org=await createBusinessOrganization(user.id,{name:`Северная пекарня ${tag}`,description:null,timezone:'Europe/Moscow'})
     const secondOrg=await createBusinessOrganization(user.id,{name:`Линия кофе ${tag}`,description:null,timezone:'Europe/Moscow'})
     const context=await browser.newContext({viewport:viewport==='mobile'?{width:320,height:568}:{width:1600,height:1100},locale:'ru-RU',reducedMotion:'reduce'})
     await context.addInitScript(theme=>{localStorage.setItem('staffly-cookie-consent','necessary');localStorage.setItem('staffly.theme',theme)},options.theme??'light')
     const login=await context.request.post(origin+'/api/auth/login',{data:{email,password},headers:{Origin:origin}});assert.equal(login.status(),200);const loginData=await login.json()
     const session=await prisma.authSession.findFirstOrThrow({where:{userId:user.id,revokedAt:null}});await prisma.authSession.update({where:{id:session.id},data:{lastActiveAt:new Date()}});await recordOrganizationPresence(user.id,session.id,org.id);await collectMonitoringSample()
     for(let day=1;day<=6;day++){await databasePool.query("INSERT INTO platform_activity_days(organization_id,user_id,day) VALUES($1,$2,(now() AT TIME ZONE 'Europe/Moscow')::date-$3::int) ON CONFLICT DO NOTHING",[org.id,user.id,day]);if(day%2===0)await databasePool.query("INSERT INTO platform_activity_days(organization_id,user_id,day) VALUES($1,$2,(now() AT TIME ZONE 'Europe/Moscow')::date-$3::int) ON CONFLICT DO NOTHING",[secondOrg.id,user.id,day])}
     await databasePool.query("INSERT INTO platform_online_samples(bucket,users_count,organizations_count,sessions_count) SELECT date_trunc('hour',now())-i*interval '1 hour',i%3+1,i%2+1,i%3+1 FROM generate_series(1,8) i ON CONFLICT DO NOTHING")
     let page=await context.newPage();let parentPage=page;page.on('pageerror',error=>result.errors.push({tag,check:activeCheck,message:error.message,stack:error.stack,url:page.url()}))
     const shot=async(label)=>{const file=`admin-${tag}-${label}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});result.screenshots.push(file)}
     const check=async(label,run)=>{activeCheck=label;result.current={tag,label};await writeFile(path.join(output,'admin-interface.json'),JSON.stringify(result,null,2));try{await run();result.checks.push({tag,label,status:'passed'});await writeFile(path.join(output,'admin-interface.json'),JSON.stringify(result,null,2))}catch(error){await shot('failure');result.checks.push({tag,label,status:'failed',error:error.message});throw error}}
     const nav=async(label)=>{const toggle=page.getByRole('button',{name:'Открыть навигацию',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.getByRole('navigation',{name:'Мониторинг',exact:true}).getByRole('link',{name:label,exact:true}).click()}
     const noOverflow=async()=>{const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.right>innerWidth+1}).slice(0,15).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,overflow:getComputedStyle(el).overflowX,text:el.textContent?.slice(0,60)}))}));assert(geometry.scroll<=geometry.width+1,'No horizontal document overflow: '+JSON.stringify(geometry))}
     try{
      await check('admin CSS preserves public login and registration backgrounds and controls',async()=>{
       const clean=await browser.newContext({viewport:viewport==='mobile'?{width:320,height:568}:{width:1600,height:1100},locale:'ru-RU'});await clean.addInitScript(theme=>localStorage.setItem('staffly.theme',theme),options.theme??'light');const publicPage=await clean.newPage();await publicPage.goto(origin+'/auth');await expect(publicPage.locator('.auth__panel')).toBeVisible();const before=await publicPage.locator('.auth').evaluate(node=>getComputedStyle(node).backgroundImage);assert(before.includes('gradient'));await publicPage.evaluate(async()=>{await import('/src/features/admin/admin-page.tsx')});assert.equal(await publicPage.locator('.auth').evaluate(node=>getComputedStyle(node).backgroundImage),before);await publicPage.getByRole('button',{name:'Регистрация',exact:true}).click();assert.equal(await publicPage.locator('.auth').evaluate(node=>getComputedStyle(node).backgroundImage),before);assert(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await publicPage.screenshot({path:path.join(output,'auth-isolation-'+tag+'.png'),fullPage:true});await publicPage.close();await clean.close()
      })
      await check('organization picker opens a new admin tab with the shared avatar and PIN modal',async()=>{
       await page.goto(origin+'/');await expect(page.getByRole('button',{name:'Открыть профиль',exact:true}).locator('.media-avatar')).toBeVisible();assert.equal(await page.getByRole('link',{name:'Администрирование',exact:true}).count(),0);await page.goto(origin+'/app');await expect(page.getByRole('heading',{name:'Ваши организации',exact:true})).toBeVisible();await expect(page.getByRole('banner').getByRole('link',{name:'Администрирование',exact:true})).toBeVisible();assert.equal(await page.locator('.organizations-page').getByRole('link',{name:'Администрирование',exact:true}).count(),0);await noOverflow();const parent=page;parentPage=parent;const popup=parent.waitForEvent('popup');await parent.getByRole('link',{name:'Администрирование',exact:true}).click();page=await popup;await page.setViewportSize(viewport==='mobile'?{width:320,height:568}:{width:1600,height:1100});page.on('pageerror',error=>result.errors.push({tag,check:activeCheck,message:error.message,stack:error.stack,url:page.url()}));assert.equal(new URL(parent.url()).pathname,'/app');assert.equal(await page.evaluate(()=>window.opener),null);await expect(page.getByRole('heading',{name:'Подтвердите вход',exact:true})).toBeVisible()
       await expect(page.locator('.admin-auth-account .admin-avatar img')).toBeVisible();await shot('login');await page.getByLabel('Пароль аккаунта',{exact:true}).fill(password);await page.getByRole('button',{name:'Получить код на почту',exact:true}).click();await expect(page.getByRole('heading',{name:'Проверьте почту',exact:true})).toBeVisible();assert(codes.get(email));await page.getByLabel('Код из письма',{exact:false}).fill(codes.get(email));await page.getByRole('button',{name:'Подтвердить код',exact:true}).click()
       await expect(page.getByRole('heading',{name:'Создайте PIN-код',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Создайте PIN-код',exact:true})).toBeVisible();assert(await page.getByRole('dialog',{name:'Создайте PIN-код',exact:true}).evaluate(node=>node.scrollHeight<=node.clientHeight+1),'First PIN setup fits without a scrollbar');assert.equal(await page.getByLabel('PIN-код из 6 цифр',{exact:false}).getAttribute('type'),'text');await expect(page.getByLabel('PIN-код из 6 цифр',{exact:false})).toBeFocused();await page.keyboard.type(pin);await page.getByRole('button',{name:'Продолжить',exact:true}).click();await expect(page.getByRole('textbox',{name:'Повторите PIN-код',exact:true})).toBeFocused();await page.keyboard.type(pin);await page.getByRole('button',{name:'Создать PIN и открыть панель',exact:true}).click();await expect(page.getByRole('heading',{name:'Обзор сервиса',exact:true})).toBeVisible();await noOverflow();await shot('overview')
      })
      if(options['admin-layout']==='true'){
       await check('all eight monitoring pages adapt to twelve desktop, tablet and phone sizes',async()=>{
        const {checkAdminLayout}=await import('./admin-layout.mjs');await checkAdminLayout({page,nav,expect,org,userId:user.id,output,result,browser:name})
       })
       continue
      }
      await check('organizations search, filters, detail and resource tabs',async()=>{
       await nav('Организации');await expect(page.getByRole('heading',{name:'Организации',exact:true})).toBeVisible();await page.getByRole('searchbox',{name:'Поиск',exact:true}).fill(org.name);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1);await noOverflow();await shot('organizations');await page.locator('tbody').getByRole('link',{name:'Подробнее',exact:true}).click();await expect(page.getByRole('heading',{name:org.name,exact:true})).toBeVisible();await noOverflow();await shot('organization-detail');await page.getByRole('button',{name:'Использование ресурсов',exact:true}).click();await expect(page.getByRole('heading',{name:'Ресурсы организации',exact:true})).toBeVisible();await page.getByRole('button',{name:'Подписка',exact:true}).click();await expect(page.getByRole('heading',{name:'Текущая подписка',exact:true})).toBeVisible()
      })
      await check('masked users and read-only user detail',async()=>{
       await nav('Пользователи');await expect(page.getByRole('heading',{name:'Пользователи',exact:true})).toBeVisible();await page.getByRole('searchbox',{name:'Поиск',exact:true}).fill(email);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1);await page.locator('tbody').getByRole('link',{name:'Профиль и организации',exact:true}).click();await expect(page.getByRole('heading',{name:'Профиль пользователя',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:/Организации пользователя/})).toBeVisible();await expect(page.locator('.admin-member-link')).toHaveCount(2);await noOverflow();await shot('users')
      })
      await check('global events and organization history have readable labels, search and filters',async()=>{
       await nav('События');await expect(page.getByRole('heading',{name:'События сервиса',exact:true})).toBeVisible();await page.getByRole('searchbox',{name:'Поиск событий',exact:true}).fill('Создание');await page.getByRole('button',{name:'Найти события',exact:true}).click();await expect(page.locator('tbody tr').first()).toContainText(/создание/i);await page.getByLabel('Раздел',{exact:true}).selectOption('organization');await expect(page.locator('tbody tr').first()).toContainText('Организация');await noOverflow();await shot('events')
      })
      await check('online and analytics show real observations and collection date',async()=>{
       await nav('Онлайн');await expect(page.getByRole('heading',{name:'Онлайн',exact:true})).toBeVisible();await expect(page.locator('.admin-table-wrap')).toContainText(org.name);await noOverflow();await shot('online');await nav('Аналитика');await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible();await expect(page.locator('.admin-main')).toContainText('История собирается');await noOverflow();await shot('analytics');const marker=await page.locator('.admin-main').evaluate(node=>{node.dataset.stable='yes';return true});assert(marker);await page.getByRole('button',{name:'Всё время',exact:true}).click();await expect(page.getByRole('heading',{name:'За всё время Staffly',exact:true})).toBeVisible();assert.equal(await page.locator('.admin-main').getAttribute('data-stable'),'yes');assert.equal(await page.locator('.admin-loading').count(),0);const chart=page.getByRole('slider').first();await chart.focus();await page.keyboard.press('ArrowLeft');await expect(page.locator('.admin-chart-tooltip').first()).toBeVisible()
      })
      await check('lock removes sensitive DOM, traps keyboard and rejects direct API access',async()=>{
       if(viewport==='mobile'&&await page.getByRole('button',{name:'Открыть навигацию',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'Открыть навигацию',exact:true}).click();await page.getByRole('button',{name:'Заблокировать панель',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Панель заблокирована',exact:true});await expect(dialog).toBeVisible();await expect(page.locator('.admin-main')).not.toContainText('Возвращаемость организаций');await expect(page.getByLabel('PIN-код',{exact:true})).toBeFocused();await page.keyboard.press('Tab');assert(await dialog.evaluate(node=>node.contains(document.activeElement)));await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await noOverflow();assert(await dialog.evaluate(node=>node.scrollHeight<=node.clientHeight+1),'PIN dialog fits without internal scroll');const field=page.getByRole('textbox',{name:'PIN-код',exact:true});await page.keyboard.press('Shift+Tab');await expect(field).toBeFocused();await expect(page.getByRole('button',{name:'Разблокировать',exact:true})).toHaveCount(0)
       let unlockRequests=0
       await page.route('**/api/admin/unlock',async route=>{unlockRequests++;await new Promise(resolve=>setTimeout(resolve,200));await route.continue()})
       try{
        await page.keyboard.type('11122');assert.equal(unlockRequests,0,'An incomplete PIN does not consume an attempt');await expect(field).toHaveValue('11122')
        await page.keyboard.type('2');await page.keyboard.press('Enter');await expect(dialog).toContainText('4 из 5');await expect(field).toHaveValue('');await expect(field).toBeEditable();await expect(field).toBeFocused();assert.equal(unlockRequests,1,'Sixth digit and Enter send only one verification');await shot('locked')
        await page.keyboard.type('7');await expect(field).toHaveValue('7');await expect(field).toHaveAttribute('aria-invalid','false');assert.equal(unlockRequests,1,'Typing again after an error does not send an incomplete PIN')
       }finally{await page.unroute('**/api/admin/unlock')}
       const response=await context.request.get(origin+'/api/admin/monitoring/overview',{headers:{Authorization:'Bearer '+loginData.accessToken}});assert.equal(response.status(),423)
       const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));for(const value of[password,pin,codes.get(email)])assert(!storage.includes(value),'Secrets are not written to browser storage')
       await page.evaluate(()=>document.querySelector('.admin-lock-backdrop').remove());const bypass=await context.request.get(origin+'/api/admin/monitoring/overview',{headers:{Authorization:'Bearer '+loginData.accessToken}});assert.equal(bypass.status(),423);await page.reload();await expect(page.getByRole('dialog',{name:'Панель заблокирована',exact:true})).toBeVisible();await expect(page.getByLabel('PIN-код',{exact:true})).toBeFocused();await page.keyboard.type(activePin);await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible()
      })
      await check('server idle expiry survives refresh and UI removal',async()=>{
       await databasePool.query("UPDATE staffly_admin.sessions SET activity_at=now()-interval '6 minutes' WHERE user_id=$1 AND revoked_at IS NULL",[user.id]);await page.reload();await expect(page.getByRole('dialog',{name:'Панель заблокирована',exact:true})).toBeVisible();await expect(page.getByLabel('PIN-код',{exact:true})).toBeFocused();await page.keyboard.type(activePin);await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible()
      })
      await check('PIN recovery confirms password and email and requires a new elevated login',async()=>{
       if(viewport==='mobile')await page.getByRole('button',{name:'Открыть навигацию',exact:true}).click()
       await page.getByRole('button',{name:'Заблокировать панель',exact:true}).click();await page.getByRole('button',{name:'Забыли PIN-код?',exact:true}).click()
       await expect(page.getByRole('dialog',{name:'Сброс PIN-кода',exact:true})).toBeVisible()
       await databasePool.query("UPDATE staffly_admin.challenges SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[user.id])
       await page.getByLabel('Пароль аккаунта',{exact:true}).fill(password);await page.getByRole('button',{name:'Получить код на почту',exact:true}).click()
       await expect(page.getByLabel('Код из письма',{exact:false})).toBeVisible();await page.getByLabel('Код из письма',{exact:false}).fill(codes.get(email))
       const nextPin='739482';await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByRole('textbox',{name:'Новый PIN-код',exact:true}).fill(nextPin);await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByRole('textbox',{name:'Повторите PIN-код',exact:true}).fill(nextPin);await page.getByRole('button',{name:'Изменить PIN-код',exact:true}).click()
       await expect(page.getByRole('heading',{name:'Подтвердите вход',exact:true})).toBeVisible();await expect(page.locator('.admin-auth-card')).toContainText('PIN-код изменён')
       await databasePool.query("UPDATE staffly_admin.challenges SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[user.id])
       await page.getByLabel('Пароль аккаунта',{exact:true}).fill(password);await page.getByRole('button',{name:'Получить код на почту',exact:true}).click();await expect(page.getByLabel('Код из письма',{exact:false})).toBeVisible();await page.getByLabel('Код из письма',{exact:false}).fill(codes.get(email));await page.getByRole('button',{name:'Подтвердить код',exact:true}).click();await expect(page.getByRole('dialog',{name:'Панель заблокирована',exact:true})).toBeVisible();await expect(page.getByLabel('PIN-код',{exact:true})).toBeFocused();await page.keyboard.type(nextPin);await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible();activePin=nextPin
      })
      await check('error screens and browser back preserve navigation on a narrow viewport',async()=>{
       await nav('Организации');await expect(page.locator('tbody tr').first()).toBeVisible();await databasePool.query('UPDATE organizations SET deleted_at=now() WHERE id=$1',[org.id]);await page.locator(`a.admin-btn[href="/admin/organizations/${org.id}"]`).click();await expect(page.getByRole('heading',{name:'Не удалось загрузить страницу',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Повторить загрузку',exact:true})).toBeVisible();await noOverflow();await shot('organization-error');await page.getByRole('button',{name:'Вернуться назад',exact:true}).click();await expect(page.getByRole('heading',{name:'Организации',exact:true})).toBeVisible();await nav('Аналитика');await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible()
      })
      if(name==='chrome'&&viewport==='desktop')await check('20-second polling keeps the page mounted and does not extend the PIN idle timeout',async()=>{
       await new Promise(resolve=>setTimeout(resolve,1000));const before=(await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[user.id])).rows[0].activity_at.toISOString();const response=await page.waitForResponse(response=>response.url().includes('/api/admin/monitoring/analytics')&&response.status()===200,{timeout:25000});assert(response.ok());const after=(await databasePool.query('SELECT activity_at FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL',[user.id])).rows[0].activity_at.toISOString();assert.equal(after,before);assert.equal(await page.locator('.admin-loading').count(),0)
      })
      await check('administrative revocation closes an existing browser session',async()=>{
       await databasePool.query('UPDATE staffly_admin.accounts SET enabled=false,version=version+1 WHERE user_id=$1',[user.id]);await page.reload();await expect(page.getByRole('heading',{name:'Доступ не предоставлен',exact:true})).toBeVisible();assert.equal(await page.locator('.admin-topbar,.admin-sidebar,.admin-main').count(),0);await noOverflow()
      })
      await check('exit revokes elevation, closes the admin window and leaves organization selection open',async()=>{
       await databasePool.query('UPDATE staffly_admin.accounts SET enabled=true,version=version+1 WHERE user_id=$1',[user.id]);await databasePool.query("UPDATE staffly_admin.challenges SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[user.id]);const headers={Origin:origin,Authorization:'Bearer '+loginData.accessToken};const challenge=await context.request.post(origin+'/api/admin/challenge',{headers,data:{password,purpose:'LOGIN'}});assert.equal(challenge.status(),200);const challengeData=await challenge.json();assert.equal((await context.request.post(origin+'/api/admin/verify',{headers,data:{challengeId:challengeData.challengeId,code:codes.get(email)}})).status(),200);assert.equal((await context.request.post(origin+'/api/admin/unlock',{headers,data:{pin:activePin}})).status(),200);await page.reload();await expect(page.getByRole('heading',{name:'Аналитика продукта',exact:true})).toBeVisible();if(viewport==='mobile'&&await page.getByRole('button',{name:'Открыть навигацию',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'Открыть навигацию',exact:true}).click();const closed=page.waitForEvent('close');await page.getByRole('button',{name:'Выйти из панели',exact:true}).click();await closed;assert(!parentPage.isClosed());assert.equal(new URL(parentPage.url()).pathname,'/app');assert.equal((await context.request.get(origin+'/api/admin/monitoring/overview',{headers})).status(),403);assert.equal((await context.request.get(origin+'/api/auth/me',{headers})).status(),200)
      })
     }finally{await context.close();await writeFile(path.join(output,'admin-interface.json'),JSON.stringify(result,null,2))}
   }finally{await browser.close()}
    }
  }
  assert.equal(result.errors.length,0,JSON.stringify(result.errors));return result
 }finally{
  await vite.close();await new Promise(resolve=>{api.close(resolve);api.closeAllConnections()});await closeAdminDatabase()
  // macOS adds deny-delete ACLs to Firefox's synthetic Library directory.
  // Remove only ACLs inside this run's private temporary browser home.
  if(process.platform==='darwin')await new Promise(resolve=>{const child=spawn('/bin/chmod',['-R','-P','-N',firefoxHome],{stdio:'ignore'});child.once('error',resolve);child.once('exit',resolve)})
 }
}
