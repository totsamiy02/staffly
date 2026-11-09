import assert from 'node:assert/strict'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'

export async function checkChartUi({ page, nav, check, expect, noOverflow, output, tag, user }) {
 const originalSize=page.viewportSize(),pattern='**/api/admin/monitoring/overview**',start=Date.now()-86400000
 let mode='dense'
 const at=i=>new Date(start+i*300000).toISOString()
 const reload=async()=>{await page.waitForLoadState('networkidle');await page.reload();await page.waitForLoadState('networkidle')}
 const layout=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const shot=async name=>{await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo({top:0,behavior:'instant'})});await layout();await page.screenshot({path:path.join(output,`charts-${tag}-${name}.png`),fullPage:true})}
 await page.route(pattern,async route=>{
  const response=await route.fetch(),data=await response.json()
  data.startedAt=at(0);data.historyRange={from:at(0),to:at(287),stepMs:300000}
  data.history=Array.from({length:288},(_,i)=>({at:at(i),users:mode==='empty'?null:mode==='large'?Math.round(i*137):mode==='zero'?0:mode==='isolated'?(i===140?1:null):i%4===0?null:i>90&&i<100||i>240&&i<250?1:0,organizations:mode==='empty'?null:mode==='large'?i*3:mode==='isolated'?null:0}))
  await route.fulfill({response,json:data})
 })
 try{
  await check('charts: dense small counters use their range without permanent points or gap stripes',async()=>{
   await nav('Обзор');await reload()
   const chart=page.locator('.admin-overview-activity .admin-chart')
   await expect(chart).toHaveAttribute('data-scale-max','1')
   await expect(chart.locator('.admin-chart-frame circle')).toHaveCount(0)
   await expect(chart.locator('.admin-chart-gap-band,.admin-chart-coverage')).toHaveCount(0)
   await expect(chart.locator('.admin-chart-line').first()).toBeAttached()
   assert.equal(await chart.locator('svg text').filter({hasText:/Нет/}).count(),0)
   await shot('dense-desktop')
   const slider=chart.getByRole('slider');await slider.focus();await page.keyboard.press('Home')
   await expect(chart.locator('.admin-chart-tooltip')).toContainText('Нет замера')
   await page.keyboard.press('ArrowRight');await expect(chart.locator('.admin-chart-tooltip')).toContainText('0')
   await page.keyboard.press('End');await expect(chart.locator('.admin-chart-tooltip')).toContainText('0')
   await slider.blur()
   for(const width of [1920,1440,1280,1024,820,600,390,320]){await page.setViewportSize({width,height:1000});await layout();await noOverflow();if([1440,820,390].includes(width))await shot('dense-'+width)}
   await page.setViewportSize(originalSize)
  })
  await check('charts: zero, single measurement, large values and empty periods remain truthful',async()=>{
   const chart=page.locator('.admin-overview-activity .admin-chart')
   for(const selected of ['zero','isolated','large','empty']){
    mode=selected;await reload()
    if(selected==='empty'){await expect(chart.locator('.admin-chart-empty')).toContainText('Пока нет наблюдений');await expect(chart.getByRole('slider')).toHaveCount(0)}
    else{await expect(chart.getByRole('slider')).toBeVisible();if(selected==='large'){assert(Number(await chart.getAttribute('data-scale-max'))>=287*137);await chart.getByRole('button',{name:'Пользователи',exact:true}).click();assert(Number(await chart.getAttribute('data-scale-max'))<2000);await chart.getByRole('button',{name:'Пользователи',exact:true}).click()}else await expect(chart).toHaveAttribute('data-scale-max','1')}
    await noOverflow();await shot(selected)
   }
  })
 }finally{await page.unroute(pattern)}
 await check('analytics: cards, zero bars and cohort cells fit every viewport',async()=>{
  await nav('Аналитика');await expect(page.locator('.admin-analytics')).toBeVisible()
  await expect(page.locator('.admin-lifetime-stats > div')).toHaveCount(6)
  await expect(page.locator('.admin-analytics [data-chart-kind=bar] .admin-chart-bar').first()).toBeAttached()
  assert.equal(await page.locator('.admin-analytics .admin-funnel-bar').first().evaluate(node=>getComputedStyle(node).height),'7px')
  for(const width of [1920,1440,1280,1024,820,600,390,320]){
   await page.setViewportSize({width,height:1000});await layout();await noOverflow()
   assert(await page.locator('.admin-analytics-grid').evaluate(node=>[...node.children].every(child=>child.getBoundingClientRect().right<=node.getBoundingClientRect().right+1)))
   if([1440,820,390].includes(width))await shot('analytics-'+width)
  }
  const audit=await new AxeBuilder({page}).include('.admin-analytics').analyze();assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[])
  await page.setViewportSize(originalSize)
 })
 await check('users: row actions sit at the right edge and remain usable in mobile cards',async()=>{
  await nav('Пользователи');await expect(page.locator('.admin-users')).toBeVisible()
  for(const width of [1600,1280,1100,1024,820,390,320]){
   await page.setViewportSize({width,height:1000});await layout();await noOverflow()
   if(width>900){
    await expect(page.locator('.admin-users table')).toBeVisible()
    const geometry=await page.locator('.admin-users tbody tr').first().evaluate(row=>{const cell=row.lastElementChild,button=cell.querySelector('a:last-child');return{cell:cell.getBoundingClientRect().right,button:button.getBoundingClientRect().right}})
    assert(geometry.cell-geometry.button<=18,'Actions have no unused space on their right')
   }else{
    await expect(page.locator('.admin-users .admin-mobile-table')).toBeVisible()
    const card=page.locator('.admin-users [data-admin-record]').first();const actions=card.locator('.admin-user-actions')
    for(const button of await actions.getByRole('link').all()){await expect(button).toBeVisible();const box=await button.boundingBox();assert(box&&box.height>=40)}
    assert(await actions.evaluate(node=>{const links=[...node.querySelectorAll('a')].map(a=>a.getBoundingClientRect());return links[0].right<=links[1].left}))
   }
   if([1600,390].includes(width))await shot('users-'+width)
  }
  await page.setViewportSize(originalSize)
  // Crossing 900px replaces cards with table rows (or the reverse). Focusing
  // before that render finishes can target a node that is about to be removed.
  await expect(page.locator(originalSize.width>900?'.admin-users table':'.admin-users .admin-mobile-table')).toBeVisible()
  const profile=page.locator(`.admin-users .admin-user-profile[href="/admin/users/${user.id}"]`)
  await expect(profile).toBeVisible();await profile.focus();await expect(profile).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Профиль пользователя',exact:true})).toBeVisible()
  await nav('Пользователи');await page.locator(`.admin-user-actions a[href="/admin/users/${user.id}/service"]`).click();await expect(page.getByRole('heading',{name:'Обслуживание аккаунта',exact:true})).toBeVisible()
 })
}
