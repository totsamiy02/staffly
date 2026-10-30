import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'

export async function runUiSmoke({ prisma, owner, org, origin, port, root, temporary, output, connect, controls, publishGuideExamples = false }) {
  const { replaceUserAvatar } = await import('../../src/server/storage/image-service.ts')
  const initialPhoto = await sharp({create:{width:120,height:120,channels:3,background:'#c53d3d'}}).png().toBuffer()
  const newPhoto = await sharp({create:{width:120,height:120,channels:3,background:'#2479d7'}}).png().toBuffer()
  const photoPath = path.join(temporary, 'profile-blue.png'); await writeFile(photoPath, newPhoto)
  await replaceUserAvatar(owner.id, initialPhoto)
  const originalAvatar = (await prisma.user.findUniqueOrThrow({where:{id:owner.id}})).avatarFileId
  const ownerMember = await prisma.organizationMember.findUniqueOrThrow({where:{organizationId_userId:{organizationId:org.id,userId:owner.id}}})
  const month = new Date().toISOString().slice(0,7)
  await prisma.workShift.createMany({data:[1,2,3].map(day=>({organizationId:org.id,locationId:org.locationId,memberId:ownerMember.id,createdByMemberId:ownerMember.id,scheduledStartAt:new Date(`${month}-${String(day).padStart(2,'0')}T06:00:00Z`),scheduledEndAt:new Date(`${month}-${String(day).padStart(2,'0')}T14:00:00Z`),actualStartAt:new Date(`${month}-${String(day).padStart(2,'0')}T06:00:00Z`),actualEndAt:new Date(`${month}-${String(day).padStart(2,'0')}T14:00:00Z`)}))})
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json()
  const cdp = await connect(target.webSocketDebuggerUrl), errors = [], checks = [], screenshots = [], network = []
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  async function wait(expression,label,timeout=30000) {
    const deadline=Date.now()+timeout
    while(Date.now()<deadline){if(await evaluate(expression))return;await delay(80)}
    throw new Error(`UI timeout: ${label}; `+JSON.stringify({network:network.slice(-20),page:await evaluate(`({text:document.body.innerText.slice(0,1400),editor:document.querySelector('.profile-editor')?.className,expressionResult:(${expression})})`)}))
  }
  async function navigate(route,selector) {
    await cdp.call('Page.navigate',{url:origin+route})
    await wait(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector('.route-loading,.app-loading')`,route)
    await delay(150)
  }
  async function click(text,selector='button,a,summary') {
    assert(await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled);if(!e)return false;e.click();return true})()`), 'Missing enabled control: '+text)
  }
  async function chooseFile() {
    const {root:document}=await cdp.call('DOM.getDocument')
    const {nodeId}=await cdp.call('DOM.querySelector',{nodeId:document.nodeId,selector:'.image-upload input[type=file]'})
    assert(nodeId,'Photo file input missing')
    await cdp.call('DOM.setFileInputFiles',{nodeId,files:[photoPath]})
    await delay(150)
  }
  const headerBlue = `(()=>{const i=document.querySelector('.topbar-profile-trigger img');if(!i?.complete||!i.naturalWidth)return false;const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(i,0,0,1,1);const p=c.getContext('2d').getImageData(0,0,1,1).data;return p[2]>p[0]+50})()`
  async function shot(name,selector,guideName) {
    await delay(300) // Capture settled controls, not the first frame of their entrance/theme transition.
    const clip=selector?await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),p=${guideName === 'location-switcher' ? "document.querySelector('.workspace-sidebar .location-switcher__popover').getBoundingClientRect()" : 'null'};return {x:Math.max(0,r.x+scrollX),y:Math.max(0,r.y+scrollY),width:Math.max(1,p?Math.max(r.width,p.right-r.left+12):r.width),height:Math.max(1,p?p.bottom-r.top+12:r.height),scale:1}})()`):undefined
    const result=await cdp.call('Page.captureScreenshot',{format:guideName?'webp':'png',...(guideName?{quality:88}:{}),captureBeyondViewport:true,...(clip?{clip}:{})})
    const bytes=Buffer.from(result.data,'base64'),file=path.join(output,name+(guideName?'.webp':'.png'))
    await writeFile(file,bytes);screenshots.push(file)
    if(guideName&&publishGuideExamples)for(const directory of ['public/guide/examples','dist/guide/examples']){await mkdir(path.join(root,directory),{recursive:true});await writeFile(path.join(root,directory,guideName+'.webp'),bytes)}
  }
  try {
    cdp.on('Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails.exception?.description??event.exceptionDetails.text))
    cdp.on('Network.responseReceived',event=>{if(/\/api\/(profile|media)/.test(event.response.url))network.push({at:Date.now(),url:new URL(event.response.url).pathname,status:event.response.status})})
    cdp.on('Runtime.consoleAPICalled',event=>{if(event.type==='error')errors.push(event.args.map(arg=>arg.description??arg.value??'').join(' '))})
    await cdp.call('Page.enable');await cdp.call('DOM.enable');await cdp.call('Network.enable');await cdp.call('Runtime.enable')
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false})
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('staffly.theme','light')"})
    const rawToken=randomUUID()+randomUUID()
    await prisma.authSession.create({data:{userId:owner.id,refreshTokenHash:createHash('sha256').update(rawToken).digest('hex'),idleExpiresAt:new Date(Date.now()+3600000),absoluteExpiresAt:new Date(Date.now()+3600000)}})
    await cdp.call('Network.clearBrowserCookies')
    await cdp.call('Network.setCookie',{name:'staffly_refresh',value:rawToken,url:origin+'/api/auth',path:'/api/auth',httpOnly:true,sameSite:'Lax'})
    await navigate('/app/settings','.profile-editor')
    await wait("!!document.querySelector('.topbar-profile-trigger img')?.naturalWidth",'Initial avatar')
    await click('Редактировать')
    await chooseFile()
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:owner.id}})).avatarFileId,originalAvatar)
    assert.equal(await evaluate(headerBlue),false,'Draft must not update header avatar')
    await click('Отмена')
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:owner.id}})).avatarFileId,originalAvatar)
    checks.push('photo selection and cancellation do not persist')
    await click('Редактировать');await chooseFile()
    controls.holdProfile()
    await prisma.user.update({where:{id:owner.id},data:{bio:'Before photo save'}})
    for(let i=0;i<100&&!controls.profileHeld;i++)await delay(50)
    assert(controls.profileHeld,'Did not capture the old profile response')
    const saveStarted = Date.now()
    await click('Сохранить','.profile-editor button')
    await wait("!!document.querySelector('.profile-editor .profile-details-groups')",'Photo save')
    assert(Date.now()-saveStarted<5000,'Saving must not wait for the held GET profile response')
    const saved=(await prisma.user.findUniqueOrThrow({where:{id:owner.id}})).avatarFileId
    assert(saved&&saved!==originalAvatar)
    controls.releaseProfile()
    await wait(headerBlue,'Header avatar after stale profile response')
    await delay(400);assert(await evaluate(headerBlue))
    checks.push('saved photo updates without reload and an older profile response cannot revert it')
    await click('Редактировать')
    await shot('profile-edit','.profile-editor','profile-save')
    await click('Отмена')
    await navigate(`/app/organizations/${org.id}` ,'.workspace-dashboard')
    assert.equal(await evaluate("document.querySelectorAll('.workspace-sidebar .role-badge,.topbar-profile-trigger .role-badge').length"),0)
    await evaluate("document.querySelector('.topbar-profile-trigger').click()")
    assert.equal(await evaluate("document.querySelectorAll('.topbar-popover--profile .role-badge').length"),0)
    await evaluate("document.querySelector('.topbar-popover--profile a[href=\"/app/settings\"]').click()")
    await wait("!!document.querySelector('.profile-editor__organization-role .role-badge')",'Role appears in the full profile')
    await navigate(`/app/organizations/${org.id}`,'.workspace-dashboard')
    assert.equal(await evaluate("document.querySelectorAll('.location-today-card').length"),6)
    await click('Далее','.point-pagination button')
    assert.equal(await evaluate("document.querySelectorAll('.location-today-card').length"),2)
    checks.push('role appears in the full profile instead of the mini menu and dashboard locations are paginated')
    await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
    await shot('location-switcher','.workspace-sidebar','location-switcher')
    await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
    const timeOrigin=await evaluate('performance.timeOrigin')
    controls.delayOrganizations(220)
    for(let i=0;i<12;i++){
      await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
      await wait("!!document.querySelector('.workspace-sidebar .location-switcher__list')",'Location choices')
      await evaluate(`document.querySelectorAll('.workspace-sidebar .location-switcher__list .location-choice')[${i%8}].click()`)
      await delay(35)
    }
    controls.delayOrganizations(0)
    const finalPoint=new URL(await evaluate('location.href')).searchParams.get('location')
    await wait(`!document.querySelector('.route-loading,.app-loading')&&document.querySelector('.workspace-sidebar .location-switcher__trigger strong')?.textContent===${JSON.stringify((await prisma.organizationLocation.findUniqueOrThrow({where:{id:finalPoint}})).name)}`,'Rapid location switches')
    assert.equal(await evaluate('performance.timeOrigin'),timeOrigin)
    checks.push('twelve rapid location switches settle without a document reload')
    const restart=controls.restart()
    await delay(150)
    await evaluate("window.dispatchEvent(new Event('focus'))")
    await restart
    await wait(headerBlue,'Avatar recovers after actual API restart',20000)
    checks.push('avatar and session survive an actual API restart')
    controls.offline(true)
    await cdp.call('Page.reload')
    await wait("!!document.querySelector('.connection-state')",'Explicit connection recovery state')
    controls.offline(false)
    await wait("!!document.querySelector('.workspace-sidebar')&&!document.querySelector('.connection-state,.app-loading')",'Automatic reconnect',20000)
    checks.push('startup outage shows retry state and recovers without manual reload')
    await navigate(`/app/organizations/${org.id}/settings`,'.organization-profile-editor')
    const originalLogo=(await prisma.organization.findUniqueOrThrow({where:{id:org.id}})).logoFileId
    await click('Редактировать','.organization-profile-editor button');await chooseFile()
    assert.equal((await prisma.organization.findUniqueOrThrow({where:{id:org.id}})).logoFileId,originalLogo)
    await click('Отмена','.organization-profile-editor button')
    assert.equal((await prisma.organization.findUniqueOrThrow({where:{id:org.id}})).logoFileId,originalLogo)
    await click('Редактировать','.organization-profile-editor button');await chooseFile()
    await click('Сохранить','.organization-profile-editor button')
    await wait("!!document.querySelector('.organization-profile-editor .profile-details-groups')",'Organization logo save')
    const savedLogo=(await prisma.organization.findUniqueOrThrow({where:{id:org.id}})).logoFileId
    assert(savedLogo&&savedLogo!==originalLogo)
    await wait("!!document.querySelector('.workspace-organization-card img')?.naturalWidth",'Sidebar logo updates without reload')
    assert.equal(await evaluate("Math.round(document.querySelector('.workspace-organization-card img').getBoundingClientRect().width)"),44)
    await evaluate("document.querySelector('.workspace-organization-card').click()")
    await wait("!!document.querySelector('.organization-info-dialog')",'Full organization header opens details')
    await evaluate("document.querySelector('.organization-info-dialog button[aria-label=\"Закрыть\"]').click()")
    await wait("!document.querySelector('.organization-info-dialog')",'Organization details close')
    await evaluate("document.querySelector('.workspace-sidebar__collapse').click()")
    await wait("!!document.querySelector('.workspace-shell--collapsed')",'Collapsed sidebar')
    await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
    await wait("!document.querySelector('.workspace-shell--collapsed')&&!!document.querySelector('.location-switcher__popover')",'Point chooser expands compact sidebar')
    await evaluate("document.querySelector('.workspace-sidebar .location-switcher__trigger').click()")
    checks.push('organization logo follows Save/Cancel and updates in the sidebar without reload')
    await navigate(`/app/organizations/${org.id}/settings?section=requests`,'.vacation-settings')
    await evaluate("document.querySelector('.holiday-editor summary').click()")
    for(let i=0;i<2;i++){
      await evaluate("document.querySelector('.holiday-editor .staffly-date button').click()")
      await wait("!!document.querySelector('.staffly-calendar [data-date]')",'Holiday calendar')
      if(i===0){
        const focused=await evaluate("document.activeElement.dataset.date")
        await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'})
        await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'})
        assert.notEqual(await evaluate("document.activeElement.dataset.date"),focused,'Keyboard must move focus inside the portaled calendar')
      }
      await evaluate(`document.querySelectorAll('.staffly-calendar [data-date]')[${i+4}].click()`)
      await click('Добавить дату','.holiday-editor button')
    }
    assert.equal(await evaluate("document.querySelectorAll('.holiday-editor__dates>span').length"),2)
    assert.equal(await evaluate("document.querySelectorAll('.holiday-editor textarea').length"),0)
    await shot('holiday-dates','.vacation-settings','holiday-dates')
    await click('Сохранить правила','.vacation-settings button')
    await wait("document.querySelector('.vacation-settings-footer button')?.disabled===false",'Holiday save')
    assert.equal((await prisma.organization.findUniqueOrThrow({where:{id:org.id}})).vacationHolidays.length,2)
    checks.push('holiday dates are chosen from a calendar and saved as chips')
    await navigate(`/app/organizations/${org.id}/schedule/work-time?location=${org.locationId}`,'.work-time-summary')
    await wait("document.querySelectorAll('.shift-history__item').length>=3",'Work time rows')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.shift-history__row')).display"),'grid')
    await shot('work-time-light','.workspace-content')
    checks.push('work time styles load on a direct route, including shift history')
    await navigate('/guide/category/management','.guide-module-layout')
    assert.equal(await evaluate("document.querySelectorAll('.guide-module-tabs,.guide-journey details').length"),0)
    assert.equal(await evaluate("document.querySelectorAll('.guide-reader-article').length===document.querySelectorAll('.guide-journey__graph a').length"),true)
    const anchor=await evaluate("document.querySelectorAll('.guide-journey__graph a')[4].hash")
    await evaluate("document.querySelectorAll('.guide-journey__graph a')[4].click()")
    await wait(`location.hash===${JSON.stringify(anchor)}&&document.querySelector('.guide-journey a[aria-current=location]')?.hash===${JSON.stringify(anchor)}`,'Guide smooth section navigation and scroll tracking')
    assert.equal(await evaluate("document.querySelectorAll('.guide-reader-article').length>4"),true)
    await navigate('/guide/profile','.guide-article-body')
    await evaluate("document.querySelector('.guide-article-section#appearance h2 a').click()")
    await wait("location.hash==='#appearance'",'Direct article section anchor')
    await evaluate("document.querySelector('.guide-figure button').click()")
    await wait("!!document.querySelector('.guide-example-dialog img')?.naturalWidth",'Guide screenshot zoom')
    await evaluate("document.querySelector('.guide-example-dialog button[aria-label*=\"Закры\"]').click()")
    await wait("!document.querySelector('.guide-example-dialog')",'Guide screenshot closes')
    checks.push('continuous guide modules, flat navigation, scroll tracking, article anchors and screenshot zoom work')
    for(const [name,route,selector]of [['dashboard',`/app/organizations/${org.id}`,'.workspace-dashboard'],['requests',`/app/organizations/${org.id}/requests?tab=incoming`,'.requests-workspace'],['calendar',`/app/organizations/${org.id}/schedule?location=${org.locationId}`,'.schedule-legend'],['work-time',`/app/organizations/${org.id}/schedule/work-time?location=${org.locationId}`,'.work-time-summary'],['guide-module','/guide/category/management','.guide-module-layout'],['guide-article','/guide/profile','.guide-article-body']]){
      await navigate(route,selector)
      await shot(name+'-light')
      await evaluate("document.querySelector('button[aria-label*=\"тёмн\"]')?.click()")
      await evaluate("localStorage.setItem('staffly.theme','dark');window.dispatchEvent(new StorageEvent('storage',{key:'staffly.theme',newValue:'dark'}))")
      await wait("document.documentElement.dataset.theme==='dark'",'Dark theme')
      if(name==='calendar'){
        assert(await evaluate("(()=>{const p=document.createElement('span');document.body.append(p);p.style.background='var(--theme-success)';const active=getComputedStyle(document.querySelector('.schedule-legend i.active')).backgroundColor===getComputedStyle(p).backgroundColor;p.style.background='var(--theme-accent)';const mine=getComputedStyle(document.querySelector('.schedule-legend__mine i')).backgroundColor===getComputedStyle(p).backgroundColor;p.remove();return active&&mine})()"),'Dark calendar indicators use visible foreground accents')
      }
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow '+name)
      await shot(name+'-dark')
    }
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
    for(const [name,route,selector]of [['guide-module','/guide/category/shifts','.guide-module-layout'],['locations',`/app/organizations/${org.id}`,'.workspace-dashboard'],['work-time',`/app/organizations/${org.id}/schedule/work-time?location=${org.locationId}`,'.work-time-summary']]){
      await navigate(route,selector);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Mobile overflow '+name);await shot(name+'-mobile')
    }
    await navigate('/guide/category/shifts','.guide-module-layout')
    await evaluate("document.querySelector('.guide-journey__toggle').click()")
    await wait("getComputedStyle(document.querySelector('.guide-journey__body')).display!=='none'",'Mobile guide navigation')
    await evaluate("document.querySelector('.guide-journey button[role=combobox]').click()")
    await wait("!!document.querySelector('.staffly-select__options [role=option]')",'Custom guide module menu')
    await evaluate("document.querySelectorAll('.staffly-select__options [role=option]')[2].click()")
    await wait("location.pathname==='/guide/category/requests'&&!!document.querySelector('.guide-module-layout')",'Guide module selection')
    checks.push('desktop/mobile screens render in both themes without horizontal overflow, with usable mobile module navigation')
    assert.equal(errors.length,0,errors.join('\n'))
    return {passed:true,checks,screenshots,consoleErrors:errors}
  } catch(error) {
    await shot('ui-failure').catch(()=>{})
    throw error
  } finally {
    controls.offline(false);controls.releaseProfile();cdp.close();await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
  }
}
