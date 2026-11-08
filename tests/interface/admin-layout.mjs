import assert from 'node:assert/strict'
import path from 'node:path'

const sizes = [
 ['monitor',1920,1080],['desktop',1600,900],['laptop-wide',1440,900],['laptop',1366,768],['laptop-small',1280,720],['short-desktop',1100,640],['tablet-landscape',1024,768],['tablet-portrait',768,1024],['phone',390,844],['phone-small',320,568],['phone-landscape',844,390],['short-window',1280,600],
]
export async function checkAdminLayout({page,nav,expect,org,userId,output,result,browser,operationsJobId,operationsErrorId}) {
 result.layoutChecks??=[]
 const routes=[
  ['security','Безопасность','Безопасность'],['backups','Резервные копии','Резервные копии'],['administrators','Администраторы','Администраторы'],['alerts','Оповещения','Оповещения'],
  ['overview','Обзор','Обзор сервиса'],['organizations','Организации','Организации'],['organization','Организации',org.name],['users','Пользователи','Пользователи'],['user','Пользователи',null],['online','Онлайн','Онлайн'],['analytics','Аналитика','Аналитика продукта'],['events','События','События сервиса'],
 ]
 if(operationsJobId&&operationsErrorId)routes.push(['service','Состояние сервиса','Состояние сервиса'],['jobs','Фоновые задачи','Фоновые задачи'],['job','Фоновые задачи','Диагностика задачи'],['support','Поддержка','Поддержка'],['diagnostic','Поддержка','Разбор сбоя'])
 for(const [route,section,title]of routes){
  await page.setViewportSize({width:1600,height:1100})
  await expect(page.locator('.admin-root')).not.toHaveClass(/has-compact-navigation/)
  await nav(section)
  if(route==='organization')await page.locator(`a.admin-org-name[href="/admin/organizations/${org.id}"]`).click()
  if(route==='job')await page.locator(`a.admin-btn[href="/admin/operations/jobs/report/${operationsJobId}"]`).click()
  if(route==='diagnostic')await page.locator(`a.admin-btn[href="/admin/operations/support/${operationsErrorId}"]`).click()
  if(route==='user')await page.locator(`a.admin-btn[href="/admin/users/${userId}"]`).click()
  await expect(page.locator('.admin-page-head h1')).toBeVisible();if(title)await expect(page.locator('.admin-page-head h1')).toHaveText(title)
  assert.equal(await page.locator('.admin-auto-refresh,[aria-label="Обновить сейчас"]').count(),0,'Update controls must be absent')
  for(const [size,width,height]of sizes){
   const label=`${browser}/${route}/${size} (${width}×${height})`
   await page.setViewportSize({width,height})
   const compact=width<=1050||height<700
   await expect(page.locator('.admin-root')).toHaveClass(compact?/has-compact-navigation/:/^(?!.*has-compact-navigation)/)
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}))
   const initial=await page.evaluate(()=>{
    const sidebar=document.querySelector('.admin-sidebar'),header=document.querySelector('.admin-topbar'),main=document.querySelector('.admin-main'),h=header.getBoundingClientRect(),s=sidebar.getBoundingClientRect()
    return{width:innerWidth,scroll:document.documentElement.scrollWidth,header:{top:h.top,bottom:h.bottom},sidebar:{top:s.top,bottom:s.bottom,client:sidebar.clientHeight,scroll:sidebar.scrollHeight,position:getComputedStyle(sidebar).position},mainLeft:main.getBoundingClientRect().left}
   })
   assert(initial.scroll<=width+1,label+': no horizontal page overflow')
   assert(Math.abs(initial.header.top)<1,label+': header anchored at viewport top')
   if(!compact){
    assert.equal(initial.sidebar.position,'fixed',label+': desktop navigation must be fixed')
    assert(Math.abs(initial.sidebar.top-initial.header.bottom)<2,label+': sidebar starts below header')
    assert(initial.sidebar.bottom<=height+1,label+': sidebar fits viewport')
    assert(initial.sidebar.scroll<=initial.sidebar.client+2,label+': no scrolling inside desktop navigation '+JSON.stringify(initial.sidebar))
    assert(initial.mainLeft>=210,label+': content leaves space for navigation')
    if(size==='laptop'&&await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+100)){
     await page.mouse.move(width-40,height/2);await page.mouse.wheel(0,420)
     await expect.poll(()=>page.evaluate(()=>scrollY>0||document.documentElement.scrollHeight<=innerHeight+100)).toBeTruthy()
    }
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
    const after=await page.locator('.admin-sidebar').boundingBox();assert(after&&Math.abs(after.y-initial.sidebar.top)<1,label+': scrolling content does not move navigation')
    const footer=await page.locator('.admin-sidebar-bottom').boundingBox();assert(footer&&footer.y+footer.height<=height+1,label+': lock/logout stay on screen')
   }else{
    assert(initial.mainLeft<40,label+': compact content uses full viewport width')
    const toggle=page.getByRole('button',{name:'Открыть навигацию',exact:true});await expect(toggle).toBeVisible();await toggle.click()
    const dialog=page.getByRole('dialog',{name:'Навигация администратора',exact:true});await expect(dialog).toBeVisible()
    const drawer=await dialog.evaluate(node=>{const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,width:r.width,client:node.clientHeight,scroll:node.scrollHeight}})
    assert(drawer.top>=-1&&drawer.bottom<=height+1&&drawer.width<=width+1,label+': drawer stays within viewport')
    assert(drawer.scroll<=drawer.client+2,label+': navigation never scrolls internally '+JSON.stringify(drawer));await expect(dialog.getByRole('button',{name:'Выйти из панели',exact:true})).toBeInViewport()
    await page.keyboard.press('Tab');assert(await dialog.evaluate(node=>node.contains(document.activeElement)),label+': navigation keeps keyboard focus')
    if(route==='overview'&&['phone-small','phone-landscape'].includes(size)){
     const file=`admin-layout-${browser}-${size}-navigation.png`;await page.screenshot({path:path.join(output,file)});result.screenshots.push(file)
    }
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();assert.equal(await page.evaluate(()=>document.body.style.overflow),'',label+': closing navigation restores page scrolling')
   }
   await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}))
   if(['laptop','phone-small'].includes(size)){
    const file=`admin-layout-${browser}-${route}-${size}.png`;await page.screenshot({path:path.join(output,file),fullPage:size==='laptop'});result.screenshots.push(file)
   }
   result.layoutChecks.push({browser,route,size,width,height,navigation:compact?'drawer':'fixed',status:'passed'})
  }
 }
 await page.setViewportSize({width:1600,height:1100})
}
