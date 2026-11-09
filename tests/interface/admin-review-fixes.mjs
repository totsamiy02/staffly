import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function checkReviewFixes({page,nav,check,expect,prisma,databasePool,password,hash,codes,email,user,org,shot,noOverflow}) {
 const dialog=()=>page.getByRole('dialog'), refresh=()=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
 const choose=async(label,name)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name,exact:true}).click()}
 async function confirmStart(){await dialog().getByLabel('Пароль вашего аккаунта',{exact:true}).fill(password);await dialog().getByRole('button',{name:'Получить код',exact:true}).click();await expect(dialog().getByLabel('Код из письма',{exact:true})).toBeVisible()}
 await check('review: search follows browser history and marks stale results while filters load or fail',async()=>{
  await nav('Организации');const input=page.getByRole('searchbox',{name:'Поиск организаций',exact:true}),missing='missing-'+randomUUID()
  await input.fill(org.name);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('[data-admin-record]')).toHaveCount(1)
  await input.fill(missing);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('[data-admin-record]')).toHaveCount(0)
  await page.goBack();await expect(input).toHaveValue(org.name);await expect(page.locator('[data-admin-record]')).toHaveCount(1)
  await page.goForward();await expect(input).toHaveValue(missing);await expect(page.locator('[data-admin-record]')).toHaveCount(0)
  await page.goBack();await expect(page.locator('[data-admin-record]')).toHaveCount(1)
  let received,release;const started=new Promise(resolve=>{received=resolve}),gate=new Promise(resolve=>{release=resolve})
  const pattern='**/api/admin/monitoring/organizations?**'
  await page.route(pattern,async route=>{if(!new URL(route.request().url()).searchParams.get('search')?.startsWith('slow-'))return route.continue();received();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'DATABASE_BUSY',message:'Тестовая задержка обновления'})})})
  try{
   await input.fill('slow-'+randomUUID());await page.getByRole('button',{name:'Найти',exact:true}).click();await started
   await expect(page.locator('.admin-read-pending')).toContainText('Применяем фильтры');await expect(page.locator('[data-admin-record]')).toHaveCount(1)
   release();await expect(page.locator('.admin-notice[role="alert"]')).toContainText('Показаны данные на');await shot('review-stale-filter')
  }finally{release();await page.unroute(pattern)}
 })
 await check('review: a delayed administrator candidate cannot replace the edited search',async()=>{
  const candidate=await prisma.user.create({data:{email:'candidate-review-'+randomUUID()+'@example.test',firstName:'Кандидат',passwordHash:hash,emailVerifiedAt:new Date()}})
  await nav('Администраторы');const input=page.getByLabel('Почта или ID пользователя',{exact:true})
  let received,release;const started=new Promise(resolve=>{received=resolve}),gate=new Promise(resolve=>{release=resolve})
  const pattern='**/api/admin/management/administrators/candidate?**'
  await page.route(pattern,async route=>{if(!route.request().url().includes(encodeURIComponent(candidate.email)))return route.continue();const response=await route.fetch();received();await gate;await route.fulfill({response}).catch(()=>{})})
  try{
   await input.fill(candidate.email);await page.getByRole('button',{name:'Найти аккаунт',exact:true}).click();await started
   await input.fill(String(user.publicId));release();await expect(page.locator('.admin-management-person')).toHaveCount(0)
   await page.getByRole('button',{name:'Найти аккаунт',exact:true}).click();await page.locator('.admin-management-person').getByRole('button',{name:'Почему действие недоступно',exact:true}).click();await expect(page.getByRole('tooltip')).toContainText('Свой административный доступ');await page.locator('.admin-topbar').click({position:{x:6,y:6}})
  }finally{release();await page.unroute(pattern)}
 })
 await check('review: expired confirmation renews safely and returning to a rule preserves its draft',async()=>{
  await databasePool.query("UPDATE staffly_admin.action_challenges SET created_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute' WHERE user_id=$1",[user.id])
  await nav('Оповещения');await page.getByRole('tab',{name:'Правила',exact:true}).click();const card=page.locator('.admin-management-rule').filter({hasText:'Участились серверные ошибки'})
  await card.getByRole('button',{name:'Настроить правило',exact:true}).click();const threshold=Number(await dialog().getByRole('spinbutton').inputValue()),draft=String(threshold+1)
  await dialog().getByRole('spinbutton').fill(draft);await dialog().getByRole('button',{name:'Продолжить',exact:true}).click();await confirmStart()
  await databasePool.query("UPDATE staffly_admin.action_challenges SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second' WHERE user_id=$1 AND used_at IS NULL",[user.id])
  await dialog().getByLabel('Код из письма',{exact:true}).fill(codes.get(email));await dialog().getByRole('button',{name:'Подтвердить действие',exact:true}).click();await expect(dialog().getByRole('button',{name:'Подготовить заново',exact:true})).toBeVisible()
  await dialog().getByRole('button',{name:'Подготовить заново',exact:true}).click();await confirmStart()
  await dialog().getByRole('button',{name:'Вернуться к параметрам',exact:true}).click();await expect(dialog().getByRole('spinbutton')).toHaveValue(draft)
  await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);await card.getByRole('button',{name:'Настроить правило',exact:true}).click();await expect(dialog().getByRole('spinbutton')).toHaveValue(draft)
  await databasePool.query("UPDATE staffly_admin.alert_rules SET threshold=threshold+2,version=version+1 WHERE key='API_ERRORS'");await refresh();await expect(dialog()).toContainText('Ваш черновик сохранён');await expect(dialog()).toContainText('Актуально:');await expect(dialog()).toContainText('Ваш вариант:')
  await dialog().getByRole('button',{name:'Использовать актуальную версию',exact:true}).click();await expect(dialog().getByRole('spinbutton')).toHaveValue(draft)
  await dialog().getByRole('button',{name:'Сбросить черновик',exact:true}).click();await page.keyboard.press('Escape')
 })
 await check('review: backup restore plan includes deletion ledger, revoked access, holds and queue checks',async()=>{
  await nav('Резервные копии');await page.getByRole('button',{name:'Как восстановить данные',exact:true}).click()
  await expect(dialog()).toContainText('последним независимым реестром');await expect(dialog()).toContainText('Отозвать восстановленные устаревшие сеансы');await expect(dialog()).toContainText('hold');await expect(dialog().getByLabel('Диагностика для копирования',{exact:true})).toHaveValue(/реестром[\s\S]*очереди[\s\S]*только после этого/)
  await noOverflow();await shot('review-restore-plan');await dialog().getByRole('button',{name:'Понятно',exact:true}).click()
 })
 await check('review: a lost successful POST is recovered by receipt and the backup job is tracked once',async()=>{
  await databasePool.query("UPDATE staffly_admin.action_challenges SET created_at=now()-interval '2 minutes',expires_at=now()+interval '1 minute' WHERE user_id=$1",[user.id])
  const pattern='**/api/admin/management/actions/execute';let executed=0
  await page.route(pattern,async route=>{executed++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed')})
  let job
  try{
   await page.getByRole('button',{name:'Создать резервную копию',exact:true}).click();await confirmStart();await dialog().getByLabel('Код из письма',{exact:true}).fill(codes.get(email));await dialog().getByRole('button',{name:'Подтвердить действие',exact:true}).click();await expect(dialog()).toHaveCount(0)
   await expect(page.locator('.admin-backup-progress')).toContainText('поставлено в очередь');assert.equal(executed,1)
   const rows=(await databasePool.query("SELECT id FROM staffly_admin.backup_jobs WHERE requested_by=$1 AND kind='CREATE'",[user.id])).rows;assert.equal(rows.length,1);job=rows[0].id;await expect(page.locator('.admin-backup-progress')).toContainText(job)
   await databasePool.query("UPDATE staffly_admin.backup_jobs SET status='RUNNING' WHERE id=$1",[job]);await refresh();await expect(page.locator('.admin-backup-progress')).toContainText('выполняется')
   await databasePool.query("UPDATE staffly_admin.backup_jobs SET status='FAILED',error_code='BACKUP_FAILED' WHERE id=$1",[job]);await refresh();await expect(page.locator('.admin-backup-progress')).toContainText('Ошибка:');await shot('review-backup-result')
  }finally{await page.unroute(pattern);if(job)await databasePool.query('DELETE FROM staffly_admin.backup_jobs WHERE id=$1',[job])}
 })
 await check('review: expired copies and criticality are explicit in labels and filters',async()=>{
  const id=randomUUID();await databasePool.query("INSERT INTO staffly_admin.backups(id,file_key,size_bytes,sha256,created_at,expires_at,verified_at,file_state) VALUES($1,$2,1,$3,now()-interval '31 days',now()-interval '1 day',now()-interval '30 days','AVAILABLE')",[id,'staffly-'+id+'.dump','a'.repeat(64)])
  try{
   await choose('Состояние копии','Срок истёк');const row=page.locator('[data-admin-record]').filter({hasText:id});await expect(row).toBeVisible();await expect(row.locator('.admin-badge')).toHaveText('Срок истёк');await expect(row.locator('.admin-badge')).toHaveClass(/amber/);await expect(row.getByRole('button',{name:'План восстановления',exact:true})).toBeDisabled()
  }finally{await databasePool.query('DELETE FROM staffly_admin.backups WHERE id=$1',[id])}
  await databasePool.query("INSERT INTO staffly_admin.alerts(rule_id,measured,threshold) SELECT id,threshold,threshold FROM staffly_admin.alert_rules WHERE key='ADMIN_DENIALS' ON CONFLICT(rule_id) WHERE resolved_at IS NULL DO NOTHING")
  await nav('Оповещения');await choose('Важность','Критические');await expect(page.locator('.admin-management-alert').first()).toBeVisible();for(const alert of await page.locator('.admin-management-alert').all())await expect(alert).toContainText('Критическое')
  await nav('Обзор');await expect(page.locator('.admin-overview-stats')).toContainText('Активные организации за 30 дней')
  await nav('Аналитика');await expect(page.getByRole('heading',{name:'Накопленные создания',exact:true})).toBeVisible();await page.getByRole('button',{name:'О накопительном учёте',exact:true}).click();await expect(page.getByRole('tooltip')).toContainText('Начало накопительного учёта:');await page.locator('.admin-topbar').click({position:{x:6,y:6}});await noOverflow();await shot('review-analytics')
 })
}
