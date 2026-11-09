import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { replaceUserAvatar, replaceOrganizationLogo } from '../../src/server/storage/image-service.ts'
import { createBusinessOrganization } from '../support/business-organization.ts'

export async function checkAdminMedia({page,nav,check,expect,prisma,hash,output,tag,noOverflow}){
 const target=await prisma.user.create({data:{email:`portrait-${randomUUID()}@example.test`,firstName:'Мария',lastName:'Портретова',passwordHash:hash,emailVerifiedAt:new Date()}})
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
 await replaceUserAvatar(target.id,png)
 const org=await createBusinessOrganization(target.id,{name:'Организация с логотипом '+tag,description:null,timezone:'Europe/Moscow'})
 await replaceOrganizationLogo(target.id,org.id,png)
 const imageLoaded=async container=>{await container.scrollIntoViewIfNeeded();const locator=container.locator('img');await expect(locator).toBeVisible();await expect.poll(()=>locator.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true)}
 const shot=async label=>{await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:path.join(output,`media-${tag}-${label}.png`),fullPage:true})}
 await check('media: unrelated user avatar loads in the list and profile with elevated access',async()=>{
  await nav('Пользователи');await page.getByRole('searchbox',{name:'Поиск пользователей',exact:true}).fill(target.id);await page.getByRole('button',{name:'Найти',exact:true}).click()
  await expect(page.locator('.admin-users [data-admin-record]')).toHaveCount(1)
  const record=page.locator('.admin-users [data-admin-record]').filter({has:page.locator(`a.admin-person-trigger[href="/admin/users/${target.id}"]`)})
  await imageLoaded(record.locator('.admin-avatar'));await noOverflow();await shot('users')
  await record.getByRole('link',{name:'Профиль и организации',exact:true}).click()
  await imageLoaded(page.locator('.admin-user-card .admin-avatar'))
  await imageLoaded(page.locator(`.admin-member-link[href="/admin/organizations/${org.id}"] .admin-mark`))
  await expect(page.getByText('У этого пользователя пока нет зарегистрированных событий.',{exact:true})).toBeVisible()
  await noOverflow();await shot('profile')
 })
 await check('media: organization logos load in lists and the organization heading',async()=>{
  await nav('Организации');await page.getByRole('searchbox',{name:'Поиск организаций',exact:true}).fill(org.id);await page.getByRole('button',{name:'Найти',exact:true}).click()
  const record=page.locator('[data-admin-record]').filter({hasText:org.name})
  await imageLoaded(record.locator('.admin-mark'));await record.getByRole('link',{name:'Подробнее',exact:true}).click()
  await imageLoaded(page.locator('.admin-heading-mark'));await noOverflow();await shot('organization')
 })
 await check('media: a deleted avatar falls back to initials without a broken image',async()=>{
  await prisma.user.update({where:{id:target.id},data:{avatarFileId:null}})
  await nav('Пользователи');await page.getByRole('searchbox',{name:'Поиск пользователей',exact:true}).fill(target.id);await page.getByRole('button',{name:'Найти',exact:true}).click()
  await expect(page.locator('.admin-users [data-admin-record]')).toHaveCount(1)
  const record=page.locator('.admin-users [data-admin-record]').filter({has:page.locator(`a.admin-person-trigger[href="/admin/users/${target.id}"]`)})
  await expect(record.locator('.admin-avatar img')).toHaveCount(0);assert((await record.locator('.admin-avatar').innerText()).trim().length>0)
  await noOverflow()
 })
}
