import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkOperations({page,nav,check,expect,org,user,pin,context,databasePool,prisma,output,result,tag,operationsJob,operationsErrorId,noOverflow,parentPage,publishOperationsSnapshot,operationsNodeId}){
  const shot=async name=>{await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));const file=`operations-${tag}-${name}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});result.screenshots.push(file)}
  await check('operations service shows real process and task snapshots without private configuration',async()=>{
    await nav('Состояние сервиса');await expect(page.getByRole('heading',{name:'Состояние сервиса',exact:true})).toBeVisible();await expect(page.locator('.admin-ops-banner')).toContainText('Приложение на связи')
    await page.locator('.admin-ops-node summary').first().click();await expect(page.locator('.admin-ops-node[open]')).toContainText('Подготовка отчётов');await expect(page.locator('.admin-ops-node[open]')).toContainText('Средний ответ')
    await noOverflow();assert(!(await page.locator('.admin-main').innerText()).includes('private-operations-ui-marker'));await shot('service')
  })
  await check('user identity and a real rejected request have copyable references searchable by the administrator',async()=>{
    await parentPage.goto(new URL(page.url()).origin+'/app/settings')
    await expect(parentPage.locator('.account-settings-content')).toContainText(String(user.publicId))
    await parentPage.getByRole('button',{name:'Открыть профиль',exact:true}).click();await expect(parentPage.locator('.profile-account-reference')).toContainText(String(user.publicId))
    const identity=path.join(output,'operations-'+tag+'-user-identity.png');await parentPage.screenshot({path:identity,fullPage:true});result.screenshots.push(path.basename(identity))
    await parentPage.goto(new URL(page.url()).origin+'/app/organizations/6f3521d3-a3a1-4bd1-b5da-1cf249394d9f')
    const reference=parentPage.locator('.request-error-reference code').first();await expect(reference).toBeVisible();const code=await reference.innerText();assert.match(code,/^[0-9a-f-]{36}$/)
    const failure=path.join(output,'operations-'+tag+'-user-error.png');await parentPage.screenshot({path:failure,fullPage:true});result.screenshots.push(path.basename(failure))
    await publishOperationsSnapshot({role:'api',ready:()=>true,nodeId:operationsNodeId,http:()=>({requests:147,errors:1,active:0,meanMs:18.4})})
    await nav('Поддержка');await page.getByRole('searchbox',{name:'Поиск диагностики',exact:true}).fill(code);await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.getByRole('link',{name:'Разобрать',exact:true}).click();await expect(page.locator('.admin-main')).toContainText(code);await expect(page.locator('.admin-main')).toContainText(String(user.publicId));await shot('user-error-diagnostic')
    await parentPage.goto(new URL(page.url()).origin+'/app')
  })
  await check('offline errors retain a visible code and arrive in support when the connection returns',async()=>{
    await context.setOffline(true)
    let code
    try{
      await nav('Фоновые задачи');const reference=page.locator('[role=alert] .request-error-reference code').first();await expect(reference).toBeVisible();code=await reference.innerText();assert.match(code,/^[0-9a-f-]{36}$/)
      await expect(page.locator('[role=alert]')).toContainText('после восстановления связи');await noOverflow();await shot('offline-error')
    }finally{await context.setOffline(false)}
    await expect.poll(async()=>await prisma.platformRequestError.count({where:{id:code,source:'client'}})).toBe(1)
    await nav('Поддержка');await page.getByRole('searchbox',{name:'Поиск диагностики',exact:true}).fill(code);await expect(page.locator('tbody tr')).toHaveCount(1);await page.getByRole('link',{name:'Разобрать',exact:true}).click();await expect(page.locator('.admin-main')).toContainText('Сообщение устройства');await shot('browser-diagnostic')
  })
  await check('support finds a real error by code and copies safe diagnostics when clipboard access is denied',async()=>{
    await nav('Поддержка');await page.getByRole('searchbox',{name:'Поиск диагностики',exact:true}).fill(operationsErrorId);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.getByRole('link',{name:'Разобрать',exact:true}).click();await expect(page.getByRole('heading',{name:'Разбор сбоя',exact:true})).toBeVisible();await expect(page.locator('.admin-main')).toContainText('42P01');await expect(page.locator('.admin-main')).toContainText(org.name)
    assert(!(await page.locator('.admin-main').innerText()).includes('private-operations-ui-marker'));assert(!(await page.locator('.admin-main').innerText()).includes(user.email))
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied')}}}))
    await page.getByRole('button',{name:'Скопировать диагностику',exact:true}).click();await expect(page.locator('.admin-ops-copy [role=status]')).toContainText('Текст выделен')
    const selection=await page.getByRole('textbox',{name:'Диагностика для копирования',exact:true}).evaluate(node=>({selected:node.value.slice(node.selectionStart,node.selectionEnd),value:node.value}));assert.equal(selection.selected,selection.value);assert(selection.selected.includes(operationsErrorId));await noOverflow();await shot('diagnostic')
    await page.getByRole('button',{name:'Вернуться назад',exact:true}).click();await expect(page.getByRole('heading',{name:'Поддержка',exact:true})).toBeVisible();await expect(page.getByRole('searchbox',{name:'Поиск диагностики',exact:true})).toHaveValue(operationsErrorId)
    assert.equal(await page.locator('.admin-nav-item.active').count(),1)
    await page.getByRole('searchbox',{name:'Поиск диагностики',exact:true}).fill(operationsJob.id);await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.getByRole('combobox',{name:'Источник',exact:true}).click();await page.getByRole('option',{name:'Подготовка отчётов',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1);await shot('support-report')

  })
  await check('support separates email failures and shows the safe SMTP cause and exhausted attempts',async()=>{
    await nav('Поддержка');const box=page.getByRole('searchbox',{name:'Поиск диагностики',exact:true})
    result.searchTransitions??=[]
    const trace=async stage=>{result.searchTransitions.push({tag,stage,url:page.url(),value:await box.inputValue(),expected:user.id});await import('node:fs/promises').then(fs=>fs.writeFile(path.join(output,'admin-interface.json'),JSON.stringify(result,null,2)))}
    await trace('before-fill');await box.fill(user.id);await trace('after-fill');await page.getByRole('combobox',{name:'Источник',exact:true}).click();await trace('after-open');await page.getByRole('option',{name:'Доставка писем',exact:true}).click();await trace('after-filter')
    await expect(box).toHaveValue(user.id);await expect.poll(()=>new URL(page.url()).searchParams.get('search')).toBe(user.id)
    await expect(page.locator('tbody tr')).toHaveCount(1);await page.getByRole('link',{name:'Разобрать',exact:true}).click();await expect(page.locator('.admin-main')).toContainText('EAUTH');await expect(page.locator('.admin-main')).toContainText('7 из 7');await expect(page.locator('.admin-main')).toContainText('Почтовый сервер отклонил авторизацию');await noOverflow();await shot('email-diagnostic')
  })
  await check('job filters preserve the mounted page and retry confirmation handles failure, focus and safe requeue',async()=>{
    await nav('Фоновые задачи');await expect(page.getByRole('heading',{name:'Фоновые задачи',exact:true})).toBeVisible()
    await page.getByRole('searchbox',{name:'Поиск задач',exact:true}).fill(org.name);await expect(page.locator('tbody tr')).toHaveCount(8);await shot('queue-states')
    await page.getByRole('searchbox',{name:'Поиск задач',exact:true}).fill('Нет такой организации');await expect(page.locator('tbody tr')).toHaveCount(0);await expect(page.locator('.admin-note').first()).toContainText('Найдено задач: 0')
    await page.getByRole('searchbox',{name:'Поиск задач',exact:true}).fill(operationsJob.id);await page.getByRole('button',{name:'Найти',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.locator('.admin-main').evaluate(node=>node.dataset.preserved='yes');await page.getByRole('combobox',{name:'Период',exact:true}).click();await page.getByRole('option',{name:'Вся доступная история',exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(1);assert.equal(await page.locator('.admin-main').getAttribute('data-preserved'),'yes');assert.equal(await page.locator('.admin-loading').count(),0)
    await page.locator(`a[href="/admin/operations/jobs/report/${operationsJob.id}"]`).click();await expect(page.getByRole('heading',{name:'Диагностика задачи',exact:true})).toBeVisible();await noOverflow();await shot('job')
    await page.getByRole('button',{name:'Повторить подготовку',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Повторить подготовку отчёта?',exact:true});await expect(dialog).toBeVisible();for(let i=0;i<6;i++){await page.keyboard.press('Tab');assert(await dialog.evaluate(node=>node.contains(document.activeElement)))}await noOverflow();await shot('retry')
    const initialSize=page.viewportSize()
    if(initialSize.width<600){await page.setViewportSize({width:844,height:390});const bounds=await dialog.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=391,'Retry dialog fits landscape viewport');await dialog.evaluate(node=>node.scrollTop=node.scrollHeight);await expect(dialog.getByRole('button',{name:'Повторить подготовку',exact:true})).toBeInViewport();await shot('retry-landscape');await page.setViewportSize(initialSize)}
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(page.getByRole('button',{name:'Повторить подготовку',exact:true})).toBeFocused();assert.equal(await page.evaluate(()=>document.body.style.overflow),'','Closing an action restores scrolling after PIN unlock')
    await page.getByRole('button',{name:'Повторить подготовку',exact:true}).click();const endpoint='**/api/admin/operations/jobs/report/'+operationsJob.id+'/retry'
    await page.route(endpoint,route=>route.fulfill({status:503,json:{code:'DATABASE_BUSY',errorId:operationsErrorId,message:'Сервис занят. Повторите попытку немного позже.'}}))
    await dialog.getByRole('button',{name:'Повторить подготовку',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByRole('button',{name:'Повторить подготовку',exact:true})).toBeEnabled();assert.equal((await prisma.reportExport.findUniqueOrThrow({where:{id:operationsJob.id}})).status,'FAILED');await page.unroute(endpoint)
    await dialog.getByRole('button',{name:'Повторить подготовку',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.locator('.admin-notice')).toContainText('Задача возвращена в очередь');await expect(page.locator('.admin-main')).toContainText('В очереди')
    const job=await prisma.reportExport.findUniqueOrThrow({where:{id:operationsJob.id}});assert.equal(job.status,'PENDING');assert.equal(job.attempts,1);assert.equal(+job.expiresAt,+operationsJob.expiresAt);await shot('requeued')
  })
  await check('server PIN lock removes an open operations dialog and prevents its write',async()=>{
    await prisma.reportExport.update({where:{id:operationsJob.id},data:{status:'FAILED',errorCode:'EXPORT_FAILED'}});await page.reload();await expect(page.getByRole('button',{name:'Повторить подготовку',exact:true})).toBeVisible();await page.getByRole('button',{name:'Повторить подготовку',exact:true}).click()
    const action=page.getByRole('dialog',{name:'Повторить подготовку отчёта?',exact:true}).getByRole('button',{name:'Повторить подготовку',exact:true});await action.focus()
    await databasePool.query("UPDATE staffly_admin.sessions SET activity_at=now()-interval '6 minutes' WHERE user_id=$1 AND revoked_at IS NULL",[user.id])
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog',{name:'Панель заблокирована',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Повторить подготовку отчёта?',exact:true})).toHaveCount(0);assert.equal((await prisma.reportExport.findUniqueOrThrow({where:{id:operationsJob.id}})).status,'FAILED')
    await expect(page.locator('.admin-main')).not.toContainText(operationsJob.id);await expect(page.getByRole('textbox',{name:'PIN-код',exact:true})).toBeFocused();await page.keyboard.type(pin);await expect(page.getByRole('heading',{name:'Диагностика задачи',exact:true})).toBeVisible()
    const protectedApi=await context.request.get(new URL(page.url()).origin+'/api/admin/operations/jobs',{headers:{Authorization:'Bearer made-up'}});assert.equal(protectedApi.status(),401)
  })
}
