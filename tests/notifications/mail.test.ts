import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import nodemailer from 'nodemailer'

// Isolated mail tests capture Nodemailer's existing transport; no actual SMTP delivery.
const originalCreateTransport = nodemailer.createTransport
const originalUser = process.env.SMTP_USER
const originalPassword = process.env.SMTP_APP_PASSWORD
const sent: Array<{ to: string; subject: string; html: string; text: string }> = []
let mail: typeof import('../../src/server/mail/transport.ts')
before(async () => {
  process.env.SMTP_USER = 'test@example.test'
  process.env.SMTP_APP_PASSWORD = 'test-only'
  nodemailer.createTransport = (() => ({ sendMail: async (message: typeof sent[number]) => { sent.push(message); return {} } })) as typeof nodemailer.createTransport
  mail = await import('../../src/server/mail/transport.ts')
  nodemailer.createTransport = originalCreateTransport
})
after(() => {
  nodemailer.createTransport = originalCreateTransport
  if (originalUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = originalUser
  if (originalPassword === undefined) delete process.env.SMTP_APP_PASSWORD; else process.env.SMTP_APP_PASSWORD = originalPassword
})
it('renders an invitation with escaped names, expiry and a registration-preserving link', async () => {
  await mail.deliverOrganizationInvitation('recipient@example.test', 'Кофейня <script>', 'Петров Иван', 'test-token', new Date('2026-10-01T12:00:00Z'))
  const message = sent.at(-1)!
  assert.equal(message.to, 'recipient@example.test')
  assert.ok(message.html.includes('Петров Иван'))
  assert.ok(message.html.includes('Кофейня &lt;script&gt;'))
  assert.ok(!message.html.includes('<script>'))
  assert.ok(message.html.includes('/app?invite=test-token'))
  assert.ok(message.html.includes('15:00:00'))
  assert.ok(message.html.includes('зарегистрируйтесь с указанной почтой'))
  assert.ok(!message.html.includes('Настроить уведомления'))
})
it('keeps mandatory codes outside subscription controls with contextual instructions', async () => {
  for (const kind of ['verification','reset'] as const) {
    await mail.deliverSecurityCode(kind, 'recipient@example.test', '123456')
    const message = sent.at(-1)!
    assert.ok(message.html.includes('>123456</span>'))
    assert.ok(message.text.includes('10 минут'))
    assert.ok(!message.html.includes('Настроить уведомления'))
  }
  for (const kind of ['ownership','deletion','location'] as const) {
    await mail.deliverSensitiveActionCode(kind,'recipient@example.test','Север','654321','Анна Петрова')
    assert.ok(sent.at(-1)!.html.includes('>654321</span>'))
    assert.ok(sent.at(-1)!.text.includes('Не запрашивали'))
    assert.ok(!sent.at(-1)!.html.includes('Настроить уведомления'))
  }
})
it('pauses direct security and invitation mail before SMTP and resumes explicitly', async () => {
  const previous = process.env.EMAIL_DELIVERY_PAUSED, count = sent.length
  try {
    process.env.EMAIL_DELIVERY_PAUSED = 'true'
    await assert.rejects(mail.deliverSecurityCode('verification', 'recipient@example.test', '123456'), { code: 'EMAIL_DELIVERY_PAUSED', status: 503 })
    await assert.rejects(mail.deliverOrganizationInvitation('recipient@example.test', 'Test', 'Test', 'test-token', new Date()), { code: 'EMAIL_DELIVERY_PAUSED' })
    assert.equal(sent.length, count)
    process.env.EMAIL_DELIVERY_PAUSED = 'false'
    await mail.deliverSecurityCode('verification', 'recipient@example.test', '123456')
    assert.equal(sent.length, count + 1)
  } finally { if (previous === undefined) delete process.env.EMAIL_DELIVERY_PAUSED; else process.env.EMAIL_DELIVERY_PAUSED = previous }
})
it('renders rounded responsive working letters with readable plain text, before/after and preference link', () => {
  const message = mail.renderEmail({title:'Ваша смена изменена',intro:'Расписание обновлено',optional:true,fields:[['Было','09:00–18:00'],['Стало','11:00–20:00'],['Причина','<img onerror=bad>']],action:{label:'Открыть смену',path:'/app/organizations/test/schedule?shift=shift-id&location=point-id'}})
  assert.ok(message.html.includes('&lt;img onerror=bad&gt;'))
  assert.ok(!message.html.includes('<img onerror'))
  assert.ok(message.html.includes('section=notifications'))
  assert.ok(message.html.includes('@media(max-width:600px)'))
  assert.ok(message.html.includes('border-radius:16px'))
  assert.ok(message.text.includes('Было: 09:00–18:00'))
  assert.ok(message.text.includes('Стало: 11:00–20:00'))
  assert.ok(message.html.includes('shift=shift-id&amp;location=point-id'))
  assert.throws(()=>mail.renderEmail({title:'Test',intro:'Test',action:{label:'Open',path:'https://evil.example'}}),/Invalid email action URL/)
})

it('renders a continuous selectable code without links or navigation',()=>{
 for(const code of ['012345','654321']){
  const message=mail.renderEmail({title:'Code',intro:'Confirm',code,codeMinutes:5})
  assert.match(message.html,new RegExp('<span class="email-code-value"[^>]*>'+code+'</span>'))
  assert(message.text.includes('Код: '+code+'\n'));assert(message.html.includes('user-select:all'));assert(message.html.includes('5 минут'))
  assert(!message.html.includes('<a '));assert(!message.html.includes('/auth/code'));assert(!message.html.includes('onclick='));assert(!message.html.includes('javascript:'));assert(!message.html.includes('?code='));assert(!message.html.includes('Нажмите на него'))
 }
})
