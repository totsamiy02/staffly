import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as socketServer } from 'node:net';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import AxeBuilder from '@axe-core/playwright';

export async function runAttention({ prisma, env, root, output, temporary, startApi }) {
  assert.equal(env.ISOLATED_TEST_CLUSTER, 'true');
  assert(path.resolve(env.LOCAL_STORAGE_ROOT).startsWith(path.resolve(temporary) + path.sep));
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, 'artifacts/browser-binaries');
  const { chromium, expect } = await import('playwright/test');
  const { createBusinessOrganization } = await import('../support/business-organization.ts');
  const { storage } = await import('../../src/server/storage/provider.ts');
  const { localDay } = await import('../../src/server/attention/policy.ts');
  const { maintainAttention } = await import('../../src/server/attention/reminders.ts');
  const socket = socketServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const origin = `http://127.0.0.1:${port}`; env.APP_ORIGIN = origin; env.RUN_BACKGROUND_WORKERS = 'false';
  const api = await startApi(), { devApiProxy } = await import('../../scripts/dev-api-proxy.ts');
  const server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, 'vite-cache'), plugins: [react(), devApiProxy(Number(new URL(api).port))], server: { host: '127.0.0.1', port, strictPort: true, watch: { ignored: ['**/artifacts/**', '**/storage/**', '**/docs/**', '**/src/server/**', '**/src/generated/**'] } }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true });
  const result = { status: 'running', checks: [], screenshots: [], errors: [] };
  const save = () => writeFile(path.join(output, 'attention.json'), JSON.stringify(result, null, 2));
  try {
    for (const theme of ['light', 'dark']) {
      for (const viewport of [{ name: 'desktop', width: 1440, height: 1050 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 780 }]) {
        // Each viewport is a separate acceptance fixture and account traffic budget.
        const owner = await prisma.user.create({ data: { email: `attention-owner-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Анна', lastName: 'Смирнова', emailNotificationCategories: { actionDigest: true, documents: true, shiftChanges: true } } });
        const org = await createBusinessOrganization(owner.id, { name: 'Кофейня «Сирень»', description: null, timezone: 'Europe/Moscow', firstLocation: { name: 'Центральная', timezone: 'Europe/Moscow', city: 'Москва', address: 'Лесная, 8' } });
        const ownerMember = await prisma.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } });
        const user = await prisma.user.create({ data: { email: `attention-person-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Михаил', lastName: 'Соколов' } });
        const member = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id } });
        await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: member.id, role: 'MEMBER' } });
        const reviewerUser = await prisma.user.create({ data: { email: `attention-reviewer-${randomUUID()}@example.test`, passwordHash: 'test-only', emailVerifiedAt: new Date(), firstName: 'Елена', lastName: 'Крылова' } });
        const reviewer = await prisma.organizationMember.create({ data: { organizationId: org.id, userId: reviewerUser.id } });
        await prisma.locationMember.create({ data: { organizationId: org.id, locationId: org.locationId, memberId: reviewer.id, role: 'ADMIN' } });
        const type = await prisma.requestType.create({ data: { organizationId: org.id, name: 'Внутренняя заявка', dateMode: 'NONE' } });
        const now = new Date(), yesterday = new Date(+now - 86400_000), tomorrow = new Date(+now + 86400_000);
        const request = (title, patch = {}) => prisma.organizationRequest.create({ data: { organizationId: org.id, locationId: org.locationId, requestTypeId: type.id, createdByMemberId: member.id, typeNameSnapshot: title, formSnapshot: { version: 1, stages: [{ name: 'Рассмотрение', memberId: ownerMember.id }] }, dueAt: yesterday, ...patch } });
        const reviewRequest = await request('Отпуск · Михаил Соколов');
        await request('Проверить остатки на складе', { status: 'APPROVED', outcome: { kind: 'TASK', status: 'OPEN', text: 'Провести сверку остатков и внести результат.', deadline: localDay(yesterday, 'Europe/Moscow'), assignees: [ownerMember.id] } });
        await request('Изменение смены · Михаил Соколов', { dueAt: tomorrow });
        await request('Заявка на закупку', { formSnapshot: { version: 1, stages: [{ name: 'Закупка', memberId: randomUUID() }] } });
        const fileKey = `organizations/${org.id}/documents/${randomUUID()}.txt`, bytes = Buffer.from('Инструкция для сотрудников. Подтвердите ознакомление.');
        const file = await prisma.storedFile.create({ data: { organizationId: org.id, uploadedByUserId: owner.id, purpose: 'DOCUMENT', objectKey: fileKey, mimeType: 'text/plain', size: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') } });
        await storage.put(fileKey, bytes);
        const doc = await prisma.document.create({ data: { organizationId: org.id, locationId: org.locationId, storedFileId: file.id, uploadedByMemberId: ownerMember.id, visibility: 'ORGANIZATION', displayName: 'Правила работы с кассой', fileName: 'rules.txt' } });
        await prisma.documentAcknowledgement.createMany({ data: [ownerMember.id, member.id].map(memberId => ({ documentId: doc.id, memberId, assignedByMemberId: ownerMember.id, deadline: new Date(localDay(yesterday, 'Europe/Moscow')) })) });
        await maintainAttention(org.id);
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
        try {
          await context.addInitScript(value => { localStorage.setItem('staffly.theme', value); localStorage.setItem('staffly-cookie-consent', 'necessary'); }, theme);
          const token = randomUUID() + randomUUID(), browserToken = randomBytes(48).toString('base64url');
          await prisma.authSession.create({ data: { userId: owner.id, browserTokenHash: createHash('sha256').update(browserToken).digest('hex'), refreshTokenHash: createHash('sha256').update(token).digest('hex'), idleExpiresAt: new Date(Date.now() + 3600000), absoluteExpiresAt: new Date(Date.now() + 3600000) } });
          await context.addCookies([{ name: 'staffly_refresh', value: token, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }, { name: 'staffly_browser', value: browserToken, domain: '127.0.0.1', path: '/api/auth', httpOnly: true, sameSite: 'Lax' }]);
          const page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
          const network = [];
          const relevant = url => url.includes('/api/') && !url.includes('/api/live');
          page.on('request', request => { if (relevant(request.url())) network.push({time:Date.now(),event:'request',url:request.url()}); });
          page.on('response', response => { if (relevant(response.url())) network.push({time:Date.now(),event:'response',status:response.status(),url:response.url()}); });
          page.on('requestfailed', request => { if (relevant(request.url())) network.push({time:Date.now(),event:'failed',error:request.failure()?.errorText,url:request.url()}); });
          page.on('requestfinished', request => { if (relevant(request.url())) network.push({time:Date.now(),event:'finished',url:request.url()}); });
          page.on('close', () => { void writeFile(path.join(output, `${theme}-${viewport.name}-network.json`), JSON.stringify(network,null,2)); });
          const check = async (name, run) => { await run(); result.checks.push({ theme, viewport: viewport.name, name }); await save(); };
          const screenshot = async name => {
            while (await page.getByRole('button', {name:'Закрыть уведомление',exact:true}).count()) await page.getByRole('button', {name:'Закрыть уведомление',exact:true}).first().click();
            const file = `${theme}-${viewport.name}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: !['reminders','notifications','task','builder','transfer','transfer-history'].includes(name) }); result.screenshots.push(file);
            if (['mine','control'].includes(name)) { const block = `${theme}-${viewport.name}-${name}-block.png`; await page.locator('.attention-panel').evaluate(element => element.scrollIntoView({block:'center'})); await page.locator('.attention-panel').screenshot({path:path.join(output,block)}); result.screenshots.push(block); }
          };
          const home = `${origin}/app/organizations/${org.id}`;
          await page.goto(home);
          const panel = page.getByRole('region', { name: 'Требует внимания', exact: true });
          await expect(panel.getByRole('link', { name: 'Открыть задачу' })).toBeVisible();
          const dismiss = page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).first();
          if (await dismiss.count()) await dismiss.click();
          await page.getByRole('button', { name: /Уведомления/ }).first().click();
          await page.getByRole('button', { name: 'Закрыть уведомления', exact: true }).click();
          await check('queue and responsive layout', async () => {
            await expect(panel.getByRole('link', { name: 'Открыть задачу' })).toBeVisible();
            await expect(panel.locator('.attention-row')).toHaveCount(4);
            assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
            assert.deepEqual((await new AxeBuilder({ page }).include('.attention-panel').analyze()).violations, []);
            await screenshot('mine');
          });
          await check('overdue and control filters', async () => {
            await panel.getByRole('button', { name: /^Просрочено/ }).click(); await expect(panel.locator('.attention-row')).toHaveCount(3);
            await panel.getByRole('button', { name: /^Под контролем/ }).click(); await expect(panel.locator('.attention-row')).toHaveCount(2);
            await screenshot('control');
            await panel.getByRole('button', { name: /^Без ответственного/ }).click(); await expect(panel.locator('.attention-row')).toHaveCount(1);
            await expect(panel.getByText('Нет доступного согласующего')).toBeVisible();
          });
          await check('shared reminder settings preserve other preferences', async () => {
            await panel.getByRole('button', { name: 'Настроить напоминания' }).click(); const dialog = page.getByRole('dialog', { name: 'Напоминания', exact: true });
            await expect(dialog.getByRole('checkbox', { name: /Заявки и задачи/ })).toBeChecked(); await screenshot('reminders');
            await dialog.getByRole('checkbox', { name: /Заявки и задачи/ }).uncheck(); await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }); assert.equal(stored.emailNotificationCategories.shiftChanges, true); assert.equal(stored.emailNotificationCategories.actionDigest, false);
            await panel.getByRole('button', { name: 'Настроить напоминания' }).click(); await dialog.getByRole('checkbox', { name: /Заявки и задачи/ }).check(); await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
          });
          await check('existing task card and completion update the queue', async () => {
            await panel.getByRole('button', { name: /^Мои действия/ }).click(); await panel.getByRole('link', { name: 'Открыть задачу' }).click();
            await expect(page.getByRole('button', { name: 'Отметить выполнение', exact: true })).toBeVisible(); await screenshot('task');
            await page.getByRole('button', { name: 'Отметить выполнение', exact: true }).click(); await expect(page.getByText('Задача: выполнена', { exact: true })).toBeVisible();
            await page.goto(home); await expect(panel.getByRole('link', { name: 'Открыть задачу' })).toHaveCount(0);
          });
          await check('own document deep link and notification preferences link', async () => {
            await page.goto(home); await panel.getByRole('link', { name: 'Ознакомиться', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
            await expect(page.getByRole('heading', { name: 'Правила работы с кассой', exact: true })).toBeVisible();
            await page.goto(home); await page.getByRole('button', { name: /Уведомления/ }).first().click();
            await expect(page.getByRole('link', { name: 'Настроить письма', exact: true })).toBeVisible(); await screenshot('notifications');
          });
          await check('task execution and review deadlines are separate fields', async () => {
            await page.goto(`${origin}/app/organizations/${org.id}/settings?section=requests`);
            await page.getByRole('button', {name:'+ Создать тип',exact:true}).click();
            const dialog = page.getByRole('dialog', {name:'Новый тип заявки',exact:true});
            await dialog.locator('summary').filter({hasText:'Дополнительные настройки'}).click();
            await dialog.getByRole('combobox',{name:/После одобрения/}).click();
            await page.getByRole('option',{name:'Создать задачу в карточке',exact:true}).click();
            await dialog.getByRole('spinbutton',{name:/Срок выполнения задачи, дней/}).fill('3');
            await expect(dialog.getByRole('spinbutton',{name:/Срок рассмотрения, дней/})).toHaveValue('7');
            await screenshot('builder');
          });
          await check('one current-stage transfer updates the queue and preserves history', async () => {
            await page.goto(home);
            await panel.locator('.attention-row').filter({hasText:'Отпуск · Михаил Соколов'}).getByRole('link',{name:'Рассмотреть'}).click();
            const dialog = page.getByRole('dialog');
            const transferButton = dialog.getByRole('button',{name:'Передать другому согласующему',exact:true});
            await expect(transferButton).toBeVisible();
            const transferEvents = dialog.getByText('Согласование передано',{exact:true});
            const historyCount = await transferEvents.count();
            await transferButton.click();
            const form = dialog.getByRole('form',{name:'Передача согласования'});
            await form.getByRole('combobox',{name:'Новый согласующий',exact:true}).click();
            await page.getByRole('option',{name:'Крылова Елена',exact:true}).click();
            await form.getByRole('textbox').fill('Коллега ведёт этот вопрос');
            await screenshot('transfer');
            await form.getByRole('button',{name:'Передать согласование',exact:true}).click();
            await expect(dialog).toHaveCount(0);
            await page.goto(`${origin}/app/organizations/${org.id}/requests?tab=incoming&request=${reviewRequest.id}&location=${org.locationId}`);
            await expect(transferEvents).toHaveCount(historyCount + 1);
            await expect(dialog.getByText(/Согласование передано:.*Крылова Елена/).first()).toBeVisible();
            const stored = await prisma.organizationRequest.findUniqueOrThrow({where:{id:reviewRequest.id}});
            assert.equal(stored.formSnapshot.stages[0].memberId,reviewer.id); assert.equal(+stored.dueAt,+reviewRequest.dueAt);
            await screenshot('transfer-history');
            await page.goto(home); await expect(panel.locator('.attention-row').filter({hasText:'Отпуск · Михаил Соколов'})).toHaveCount(0);
            await panel.getByRole('button',{name:/^Под контролем/}).click(); await expect(panel.locator('.attention-row').filter({hasText:'Отпуск · Михаил Соколов'})).toHaveCount(1);
          });
        } catch (error) {
          const activity = await prisma.$queryRaw`SELECT pid,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE datname=current_database() AND state<>'idle'`;
          await writeFile(path.join(output, `${theme}-${viewport.name}-database.json`),JSON.stringify(activity,null,2));
          for (const page of context.pages()) { await page.screenshot({path:path.join(output, `${theme}-${viewport.name}-failure.png`),fullPage:true}).catch(()=>{}); await writeFile(path.join(output, `${theme}-${viewport.name}-failure.txt`),await page.locator('body').innerText().catch(()=>'')); }
          throw error;
        } finally { await context.close(); }
      }
    }
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors)); result.status = 'passed'; await save(); return result;
  } catch (error) { result.status = 'failed'; result.errors.push(error.message); await save(); throw error; }
  finally { await browser.close(); await server.close(); }
}
