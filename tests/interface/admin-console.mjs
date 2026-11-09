import assert from 'node:assert/strict'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'

export async function checkConsole({page,check,expect,output,tag,noOverflow,databasePool,operationsErrorId}){
  const original=page.viewportSize(),sizes=[320,390,768,820,1280,1440,1600]
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const open=async url=>{await page.waitForLoadState('networkidle');await page.goto(new URL(url,page.url()).href);await page.waitForLoadState('networkidle');await expect(page.locator('.admin-console')).toBeVisible();await expect(page.locator('.admin-loading')).toHaveCount(0)}
  const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo({top:0,behavior:'instant'})});await settle();await page.screenshot({path:path.join(output,`console-${tag}-${name}.png`),fullPage:true})}
  await databasePool.query('UPDATE staffly_admin.management_state SET alerts_checked_at=NULL WHERE id=1')
  await databasePool.query('SELECT public.platform_reconcile_admin_alerts()')
  const routes=[
    ['status','/admin/operations/service','Состояние сервиса'],
    ['checks','/admin/operations/service?view=checks','Детальные проверки'],
    ['jobs','/admin/operations/jobs','Фоновые задачи'],
    ['support','/admin/operations/support','Поддержка'],
    ['diagnostic','/admin/operations/support/'+operationsErrorId,'Разбор сбоя'],
    ['access','/admin/operations/access','Диагностика прав'],
    ['security','/admin/management/security?view=journal','Безопасность'],
    ['backups','/admin/management/backups','Резервные копии'],
    ['administrators','/admin/management/administrators','Администраторы'],
    ['alerts-active','/admin/management/alerts','Оповещения'],
    ['alerts-history','/admin/management/alerts?view=history','Оповещения'],
    ['alerts-rules','/admin/management/alerts?view=rules','Оповещения'],
  ]
  for(const [name,url,title]of routes){
    await check(`console: ${name} keeps its content, actions and geometry at seven widths`,async()=>{
      await page.setViewportSize({width:1440,height:1000});await open(url)
      await expect(page.locator('.admin-page-head h1')).toHaveText(title)
      for(const width of sizes){
        await page.setViewportSize({width,height:1000});await settle();await noOverflow()
        const geometry=await page.locator('.admin-console').evaluate(node=>{
          const stat=[...node.querySelectorAll('.admin-stat')].map(item=>item.getBoundingClientRect())
          const banner=node.querySelector('.admin-ops-banner > section')?.getBoundingClientRect()
          const header=document.querySelector('.admin-topbar').getBoundingClientRect()
          return{stat:stat.map(item=>({x:item.x,y:item.y})),banner:banner?{width:banner.width}:null,header:{top:header.top,bottom:header.bottom},badButtons:[...node.querySelectorAll('.admin-btn')].filter(button=>button.getBoundingClientRect().width>0&&button.scrollWidth>button.clientWidth+3).map(button=>button.textContent)}
        })
        assert.equal(geometry.header.top,0,`${name}/${width}: header stays anchored`)
        assert.deepEqual(geometry.badButtons,[],`${name}/${width}: button labels fit`)
        if(width<=1024&&geometry.stat.length>=4)assert(geometry.stat[2].y>geometry.stat[0].y,`${name}/${width}: two KPI per row`)
        if(name==='status'&&width>=1280)assert(geometry.banner.width>400,'Service summary has usable text width')
        if([390,820,1440].includes(width))await shot(name+'-'+width)
      }
      const audit=await new AxeBuilder({page}).include('.admin-console').analyze()
      assert.deepEqual(audit.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})),[])
    })
  }
  await check('console: rule dialog keeps validation, keyboard focus and footer actions on small screens',async()=>{
    await page.setViewportSize({width:1440,height:1000});await open('/admin/management/alerts?view=rules')
    const card=page.locator('.admin-management-rule').first(),trigger=card.getByRole('button',{name:'Настроить правило',exact:true})
    await trigger.click();const dialog=page.getByRole('dialog'),input=dialog.getByRole('spinbutton')
    await expect(input).toBeFocused();await input.fill('');await expect(dialog.getByRole('button',{name:'Продолжить',exact:true})).toBeDisabled();await expect(input).toHaveAttribute('aria-invalid','true')
    await dialog.getByRole('button',{name:'Сбросить черновик',exact:true}).click()
    for(const width of sizes){
      await page.setViewportSize({width,height:width<700?640:1000});await settle()
      await dialog.evaluate(node=>node.scrollTo(0,node.scrollHeight));await settle()
      await expect(dialog.getByRole('button',{name:'Продолжить',exact:true})).toBeInViewport()
      const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1)
      if([390,820,1440].includes(width))await shot('rule-dialog-'+width)
    }
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused()
  })
  await check('console: rule switch preserves its state when protected confirmation is cancelled',async()=>{
    await page.setViewportSize(original);await open('/admin/management/alerts?view=rules')
    const toggle=page.getByRole('switch',{disabled:false}).first();await expect(toggle).toBeVisible();const before=await toggle.getAttribute('aria-checked')
    await toggle.click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-checked',before);await expect(toggle).toBeEnabled()
  })
  await check('console: detailed component checks refresh the real service endpoint',async()=>{
    await open('/admin/operations/service?view=checks');const response=page.waitForResponse(response=>response.url().includes('/api/admin/operations/service')&&response.status()===200)
    await page.getByRole('button',{name:'Повторить проверку',exact:true}).click();await response
    await expect(page.getByRole('heading',{name:'Результаты текущей проверки',exact:true})).toBeVisible();await noOverflow()
  })
  await page.setViewportSize(original)
}
