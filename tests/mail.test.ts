import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import nodemailer from 'nodemailer'

// Isolated mail tests capture Nodemailer's existing transport; no actual SMTP delivery.
const originalCreateTransport = nodemailer.createTransport
const originalUser = process.env.SMTP_USER
const originalPassword = process.env.SMTP_APP_PASSWORD
const sent: Array<{ to: string; subject: string; html: string; text: string }> = []
let mail: typeof import('../src/server/mail.ts')
before(async () => {
  process.env.SMTP_USER = 'test@example.test'
  process.env.SMTP_APP_PASSWORD = 'test-only'
  nodemailer.createTransport = (() => ({ sendMail: async (message: typeof sent[number]) => { sent.push(message); return {} } })) as typeof nodemailer.createTransport
  mail = await import('../src/server/mail.ts')
  nodemailer.createTransport = originalCreateTransport
})
after(() => {
  nodemailer.createTransport = originalCreateTransport
  if (originalUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = originalUser
  if (originalPassword === undefined) delete process.env.SMTP_APP_PASSWORD; else process.env.SMTP_APP_PASSWORD = originalPassword
})
it('renders invitation logo, inviter name, expiry and a safe registration-preserving link using the existing mail template', async () => {
  await mail.deliverOrganizationInvitation('recipient@example.test', 'Кофейня <script>', 'Петров Иван', 'test-token', new Date('2026-10-01T12:00:00Z'), '/api/media/123')
  const message = sent.at(-1)!
  assert.equal(message.to, 'recipient@example.test')
  assert.ok(message.html.includes('Петров Иван'))
  assert.ok(message.html.includes('/api/media/123'))
  assert.ok(message.html.includes('Кофейня &lt;script&gt;'))
  assert.ok(!message.html.includes('<script>'))
  assert.ok(message.html.includes('/app?invite=test-token'))
  assert.ok(message.html.includes('15:00:00'))
  assert.ok(message.html.includes('зарегистрируйтесь с этим адресом'))
  await mail.deliverOrganizationInvitation('recipient@example.test', 'Кофейня', 'sender@example.test', 'fallback-token', new Date('2026-10-01T12:00:00Z'))
  assert.ok(sent.at(-1)!.html.includes('text-align:center;font-size:22px'))
})
it('distinguishes assigned/changed/cancelled shifts and links to the exact shift', async () => {
  for (const [type, title] of [['SHIFT_ASSIGNED', 'Назначена смена'], ['SHIFT_CHANGED', 'Смена изменена'], ['SHIFT_CANCELLED', 'Смена отменена']] as const) {
    await mail.deliverShiftAssignment('recipient@example.test', 'org-id', 'Кофейня', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T08:00:00Z'), 'Asia/Vladivostok', 'shift-id', type)
    const message = sent.at(-1)!
    assert.ok(message.subject.startsWith(title))
    assert.ok(message.html.includes('month=2026-10&amp;shift=shift-id'))
    assert.ok(message.text.includes('shift=shift-id'))
  }
})
it('renders request decisions and retains essential security email templates', async () => {
  await mail.deliverRequestDecision('recipient@example.test', 'org-id', 'Кофейня', 'request-id', 'Отпуск', 'REJECTED', '<img onerror=bad>')
  assert.equal(sent.at(-1)!.subject, 'Заявка отклонена — Staffly')
  assert.ok(sent.at(-1)!.html.includes('request=request-id'))
  assert.ok(sent.at(-1)!.html.includes('&lt;img onerror=bad&gt;'))
  await mail.deliverRequestDecision('recipient@example.test', 'org-id', 'Кофейня', 'request-id', 'Отпуск', 'APPROVED', null)
  assert.equal(sent.at(-1)!.subject, 'Заявка одобрена — Staffly')
  await mail.deliverPasswordChanged('recipient@example.test')
  assert.equal(sent.at(-1)!.subject, 'Пароль изменён — Staffly')
  await mail.deliverSecurityCode('verification', 'recipient@example.test', '123456')
  assert.ok(sent.at(-1)!.html.includes('123456'))
  await mail.deliverRoleChanged('recipient@example.test', 'Кофейня', 'Администратор')
  assert.ok(sent.at(-1)!.html.includes('Администратор'))
})
