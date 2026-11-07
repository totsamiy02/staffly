import assert from 'node:assert/strict'
import path from 'node:path'
import { expect } from 'playwright/test'

// Start on the public page in a fresh context, before any workspace CSS loads.
// Then compare the same account controls across independently loaded routes.
export async function profileMenuScenarios({page,origin,fixture,browser,preset,results,output}) {
  const routes=[['home','/'],['organizations','/app'],['settings','/app/settings'],['workspace',`/app/organizations/${fixture.org.id}`],['home-after-app','/']]
  let initial
  for(const [name,route]of routes){
    if(name==='home-after-app'){
      await page.getByRole('link',{name:'На главную Staffly',exact:true}).click()
      await expect(page).toHaveURL(origin+'/')
      await expect(page.locator('header.header')).toBeVisible()
      await expect(page.locator('.app-topbar')).toHaveCount(0)
    }
    else await page.goto(origin+route)
    await page.waitForFunction(()=>document.querySelector('main')&&!document.querySelector('.route-loading,.app-loading'))
    const trigger=page.getByRole('button',{name:'Открыть профиль',exact:true})
    await expect(trigger).toBeVisible({timeout:20000})
    await trigger.focus();await page.keyboard.press('Enter')
    const menu=page.getByRole('region',{name:'Профиль пользователя',exact:true})
    await expect(menu).toBeVisible()
    await page.evaluate(()=>document.fonts.ready)
    const appearance=await page.locator('.profile-menu').evaluate(root=>{
      const parts={trigger:'.topbar-profile-trigger',avatar:'.topbar-profile-trigger .media-avatar',menu:'.topbar-popover--profile',preview:'.profile-preview__avatar',title:'.profile-preview strong',email:'.profile-preview>div>span',settings:'a[href="/app/settings"]',logout:'.profile-preview__logout'}
      const properties=['display','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','padding','border','borderRadius','boxShadow']
      const result=Object.fromEntries(Object.entries(parts).map(([key,selector])=>{
        const node=root.querySelector(selector),style=getComputedStyle(node)
        const values=Object.fromEntries(properties.map(property=>[property,style[property]]))
        if(['avatar','preview','menu'].includes(key))values.width=style.width
        if(['avatar','preview'].includes(key))values.height=style.height
        return[key,values]
      }))
      const glyph=getComputedStyle(root.querySelector('.profile-preview .member-profile-avatar__image')??root.querySelector('.profile-preview__avatar'))
      result.previewGlyph=Object.fromEntries(['color','fontFamily','fontSize','fontWeight','lineHeight'].map(property=>[property,glyph[property]]))
      return result
    })
    if(!initial)initial=appearance
    else assert.deepEqual(appearance,initial,`${browser}/${preset}/${name}: account menu styling must not depend on route or loaded workspace CSS`)
    const bounds=await menu.boundingBox(),viewport=page.viewportSize()
    assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1,`${name}: account menu stays within viewport`)
    if(name==='workspace')await expect(menu.getByText('Мой профиль в организации',{exact:true})).toBeVisible()
    else await expect(menu.getByText('Мой профиль в организации',{exact:true})).toHaveCount(0)
    const file=`${browser}-${preset}-profile-menu-${name}.png`
    await menu.screenshot({path:path.join(output,file)});results.screenshots.push(file)
    await page.keyboard.press('Escape');await expect(menu).not.toBeVisible()
    await trigger.click();await expect(menu).toBeVisible();await page.mouse.click(5,200);await expect(menu).not.toBeVisible()
    results.checks.push({browser,preset,name:'shared-profile-menu-'+name,passed:true})
  }
}
