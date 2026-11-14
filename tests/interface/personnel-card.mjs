import assert from 'node:assert/strict';
import path from 'node:path';
export async function checkPersonnelCard({ op, ep, mp, origin, base, location, org, member, employee, prisma, check, expect, tokens, output, viewport, theme }) {
    const api = origin + '/api/organizations/' + org.id, headers = () => ({
        Origin: origin,
        Authorization: tokens.get(op)
    });
    const openProfile = async (page) => {
        await page.goto(origin + base + '/employees' + location);
        const row = page.locator('.member-row').filter({ has: page.locator('.member-row__identity strong').filter({ hasText: 'Сотрудник' }) });
        await expect(row).toBeVisible();
        const heading = await page.locator('.workspace-page-heading').boundingBox(), tabs = await page.locator('.members-navigation').boundingBox();
        assert(heading && tabs && tabs.y >= heading.y + heading.height, 'Employee tabs belong below the page heading');
        await row.locator('.member-profile-trigger').click();
        await expect(page.locator('.member-personnel')).toBeVisible();
    };
    const fit = async (page) => {
        const size = await page.evaluate(() => ({
            w: document.documentElement.clientWidth,
            s: document.documentElement.scrollWidth
        }));
        assert(size.s <= size.w + 1);
        for (const selector of ['.member-profile-dialog', '.member-personnel', '.member-personnel-editor']) {
            const elements = page.locator(selector);
            for (const element of await elements.all()) {
                const size = await element.evaluate(node => ({
                    width: node.clientWidth,
                    scroll: node.scrollWidth
                }));
                assert(size.scroll <= size.width + 1, selector + ' fits its container');
            }
        }
    };
    const checkWidths = async (page, label) => {
        const original = page.viewportSize();
        for (const width of viewport === 'desktop' ? [768, 1920] : [320]) {
            await page.setViewportSize({
                width,
                height: 900
            });
            await fit(page);
            if (label === 'personnel-history')
                await page.locator('.member-personnel-history').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(output, viewport + '-' + theme + '-' + label + '-' + width + '.png') });
        }
        await page.setViewportSize(original);
    };
    let staleForm;
    await check('owner fills the fixed personnel card without changing the personal account', async () => {
        await openProfile(op);
        await expect(op.locator('.member-personnel__empty')).toContainText('Карточка пока не заполнена');
        await op.screenshot({ path: path.join(output, viewport + '-' + theme + '-personnel-empty.png') });
        await checkWidths(op, 'personnel-empty');
        await op.getByRole('button', {
            name: 'Изменить сведения',
            exact: true
        }).click();
        const form = op.getByRole('dialog', {
            name: 'Кадровые сведения',
            exact: true
        });
        await form.getByRole('textbox', {
            name: 'Фамилия *',
            exact: true
        }).fill('Кадровый');
        await form.getByRole('textbox', {
            name: 'Имя *',
            exact: true
        }).fill('Иван');
        await form.getByRole('textbox', {
            name: 'Табельный номер',
            exact: true
        }).fill('UI-01');
        await form.getByRole('textbox', {
            name: 'Рабочая почта',
            exact: true
        }).fill('initial-work@example.test');
        await form.getByRole('textbox', {
            name: 'Рабочий телефон',
            exact: true
        }).fill('+7 (999) 123-45-67');
        await fit(op);
        await checkWidths(op, 'personnel-form');
        await op.screenshot({
            path: path.join(output, viewport + '-' + theme + '-personnel-edit.png'),
            fullPage: false
        });
        await form.getByRole('button', {
            name: 'Сохранить',
            exact: true
        }).click();
        await expect(form).toBeHidden();
        await expect(op.locator('.member-personnel')).toContainText('Кадровый');
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: employee.id } })).firstName, 'Сотрудник');
        await op.getByRole('button', {
            name: 'История кадровых изменений',
            exact: true
        }).click();
        await expect(op.locator('.member-personnel-history')).toContainText('UI-01');
        await checkWidths(op, 'personnel-history');
        await op.screenshot({
            path: path.join(output, viewport + '-' + theme + '-personnel-history.png'),
            fullPage: false
        });
        await op.getByRole('button', {
            name: 'Изменить сведения',
            exact: true
        }).click();
        staleForm = op.getByRole('dialog', {
            name: 'Кадровые сведения',
            exact: true
        });
        await staleForm.getByRole('textbox', {
            name: 'Табельный номер',
            exact: true
        }).fill('STALE-02');
    });
    await check('employee edits own working contacts; a lost response is retried without duplicate history', async () => {
        await ep.goto(origin + base + '/employees' + location);
        await ep.getByRole('button', {
            name: 'Открыть профиль',
            exact: true
        }).click();
        await ep.getByRole('button', {
            name: 'Мой профиль в организации',
            exact: false
        }).click();
        await ep.getByRole('button', {
            name: 'Изменить мои рабочие контакты',
            exact: true
        }).click();
        const form = ep.getByRole('dialog', {
            name: 'Мои рабочие контакты',
            exact: true
        });
        assert.equal(await form.getByRole('textbox').count(), 2);
        await form.getByRole('textbox', {
            name: 'Рабочая почта',
            exact: true
        }).fill('employee-work@example.test');
        const ownerRefresh = op.waitForResponse(async (response) => response.request().method() === 'GET' && response.url().includes('/members/' + member.id + '/personnel') && response.ok() && (await response.json()).record?.personnelRevision === 3);
        const lost = async (route) => {
            if (route.request().method() === 'PATCH') {
                const response = await route.fetch();
                assert.equal(response.status(), 200);
                await route.abort('failed');
            }
            else
                await route.continue();
        };
        await ep.route('**/api/organizations/*/members/*/personnel?*', lost);
        await form.getByRole('button', {
            name: 'Сохранить',
            exact: true
        }).click();
        await expect(form.locator('[role=alert]')).toBeVisible();
        await expect(form.getByRole('textbox', {
            name: 'Рабочая почта',
            exact: true
        })).toHaveValue('employee-work@example.test');
        await ep.unroute('**/api/organizations/*/members/*/personnel?*', lost);
        await form.getByRole('button', {
            name: 'Сохранить',
            exact: true
        }).click();
        await expect(form).toBeHidden();
        await ownerRefresh;
        assert.equal(await prisma.accessAudit.count({ where: {
                organizationId: org.id,
                action: 'PERSONNEL_UPDATED'
            } }), 2);
        assert.equal(await ep.getByRole('button', {
            name: 'Изменить сведения',
            exact: true
        }).count(), 0);
        assert.equal(await ep.getByRole('button', {
            name: 'История кадровых изменений',
            exact: true
        }).count(), 0);
        await fit(ep);
        await ep.screenshot({
            path: path.join(output, viewport + '-' + theme + '-personnel-own.png'),
            fullPage: false
        });
        await ep.keyboard.press('Escape');
        await expect(ep.locator('.member-profile-dialog')).toBeHidden();
    });
    await check('a stale personnel editor cannot overwrite an employee contact update after a live refresh', async () => {
        await staleForm.getByRole('button', {
            name: 'Сохранить',
            exact: true
        }).click();
        await expect(staleForm.locator('[role=alert]')).toContainText('Карточка уже изменена');
        const saved = await prisma.organizationMember.findUniqueOrThrow({ where: { id: member.id } });
        assert.equal(saved.personnelNumber, 'UI-01');
        assert.equal(saved.workEmail, 'employee-work@example.test');
        assert.equal(saved.personnelRevision, 3);
        await staleForm.getByRole('textbox', {
            name: 'Табельный номер',
            exact: true
        }).fill('UI-01');
        await staleForm.getByRole('textbox', {
            name: 'Рабочая почта',
            exact: true
        }).fill('employee-work@example.test');
        await staleForm.getByRole('button', {
            name: 'Сохранить',
            exact: true
        }).click();
        await expect(staleForm).toBeHidden();
        await op.keyboard.press('Escape');
        await expect(op.locator('.member-profile-dialog')).toBeHidden();
    });
    await check('owner grants personnel read and history through existing roles; manager has no edit access', async () => {
        const roles = await op.request.get(api + '/access/roles', { headers: headers() }), role = (await roles.json()).roles.find(r => r.systemCode === 'ADMIN');
        const response = await op.request.put(api + '/access/roles/' + role.id, {
            headers: headers(),
            data: {
                name: role.name,
                description: role.description,
                revision: role.revision,
                permissions: [...role.permissions, 'members.personnel.view', 'members.personnel.history']
            }
        });
        assert.equal(response.status(), 200);
        await openProfile(mp);
        await expect(mp.locator('.member-personnel')).toContainText('Кадровый');
        assert.equal(await mp.getByRole('button', {
            name: 'Изменить сведения',
            exact: true
        }).count(), 0);
        await mp.getByRole('button', {
            name: 'История кадровых изменений',
            exact: true
        }).click();
        await expect(mp.locator('.member-personnel-history')).toContainText('employee-work@example.test');
        await fit(mp);
        await mp.keyboard.press('Escape');
        await expect(mp.locator('.member-profile-dialog')).toBeHidden();
    });
}
