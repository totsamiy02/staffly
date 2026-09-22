import nodemailer from 'nodemailer'

export const appUrl = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const smtpUser = process.env.SMTP_USER
const smtpPassword = process.env.SMTP_APP_PASSWORD
const smtpReady = Boolean(smtpUser && smtpPassword)

if (process.env.NODE_ENV === 'production' && !smtpReady) throw new Error('SMTP_USER and SMTP_APP_PASSWORD are required in production')
if (process.env.NODE_ENV === 'development' && !smtpReady) console.log('SMTP is not configured: email contents will be printed in this terminal.')

const transport = smtpReady ? nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'smtp.yandex.ru',
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: Number(process.env.SMTP_PORT ?? 465) === 465,
  auth: { user: smtpUser?.endsWith('@yandex.ru') ? smtpUser.split('@')[0] : smtpUser, pass: smtpPassword },
}) : null

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!)
}

function emailHtml(title: string, text: string, content = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:32px 12px;background:#f4f4f4;color:#181818;font-family:Arial,Helvetica,sans-serif"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6e6;border-radius:16px"><tr><td style="padding:38px 40px"><div style="font-size:25px;font-weight:700;letter-spacing:-1px">Staffly</div><div style="height:1px;background:#e9e9e9;margin:28px 0"></div><h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">${escapeHtml(title)}</h1><p style="margin:0;color:#555;font-size:15px;line-height:1.6">${text}</p>${content}<div style="height:1px;background:#e9e9e9;margin:30px 0 20px"></div><p style="margin:0;color:#888;font-size:12px;line-height:1.6">Если вы не запрашивали это действие, просто проигнорируйте письмо.<br>Автоматическое сообщение Staffly.</p></td></tr></table></body></html>`
}

async function sendMail(email: string, subject: string, text: string, html: string, developmentLog: string) {
  if (!transport) {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') throw new Error('SMTP is not configured')
    console.log(`[DEV ONLY] ${developmentLog}`)
    return
  }
  await transport.sendMail({ from: { name: 'Staffly', address: smtpUser! }, to: email, subject, text, html })
}

function codeBlock(code: string) {
  return `<div style="margin:30px 0;padding:20px;border:1px solid #dedede;border-radius:12px;background:#f8f8f8;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px">${escapeHtml(code)}</div><p style="margin:0;color:#666;font-size:13px;line-height:1.6">Код действует 10 минут. Никому его не сообщайте.</p>`
}

export function deliverSecurityCode(kind: 'verification' | 'reset', email: string, code: string) {
  const verification = kind === 'verification'
  const subject = verification ? 'Код подтверждения почты — Staffly' : 'Код восстановления пароля — Staffly'
  const heading = verification ? 'Подтвердите почту' : 'Восстановление доступа'
  const explanation = verification
    ? 'Введите этот код на странице регистрации Staffly, чтобы подтвердить адрес электронной почты.'
    : 'Введите этот код на странице восстановления Staffly, чтобы задать новый пароль.'
  return sendMail(email, subject, `${heading}\n${explanation}\nКод: ${code}\nКод действует 10 минут.`, emailHtml(heading, explanation, codeBlock(code)), `${kind} code for ${email}: ${code}`)
}

export function deliverOrganizationCreated(email: string, organizationName: string) {
  const safeName = escapeHtml(organizationName)
  return sendMail(email, 'Организация создана — Staffly', `Организация «${organizationName}» успешно создана в Staffly.`, emailHtml('Организация создана', `Организация <strong>«${safeName}»</strong> успешно создана. Теперь вы можете приглашать сотрудников и настраивать рабочее пространство.`), `organization created for ${email}: ${organizationName}`)
}

export function deliverOrganizationInvitation(email: string, organizationName: string, inviterEmail: string, token: string, expiresAt: Date) {
  const link = `${appUrl}/app?invite=${encodeURIComponent(token)}`
  const safeName = escapeHtml(organizationName)
  const safeInviter = escapeHtml(inviterEmail)
  const button = `<div style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Открыть приглашение</a></div><p style="margin:0;color:#666;font-size:13px;line-height:1.6">Приглашение действует до ${escapeHtml(expiresAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} по московскому времени.</p>`
  return sendMail(email, `Приглашение в ${organizationName} — Staffly`, `${inviterEmail} приглашает вас присоединиться к организации «${organizationName}».\n${link}`, emailHtml('Приглашение в организацию', `<strong>${safeInviter}</strong> приглашает вас присоединиться к организации <strong>«${safeName}»</strong>. Войдите или зарегистрируйтесь с этим адресом электронной почты.`, button), `organization invitation for ${email}: ${link}`)
}

export function deliverSensitiveActionCode(kind: 'ownership' | 'deletion', email: string, organizationName: string, code: string) {
  const ownership = kind === 'ownership'
  const title = ownership ? 'Передача владения' : 'Удаление организации'
  const action = ownership ? `подтвердить передачу владения организацией «${organizationName}»` : `подтвердить удаление организации «${organizationName}»`
  return sendMail(email, `${title} — Staffly`, `Используйте код ${code}, чтобы ${action}. Код действует 10 минут.`, emailHtml(title, `Используйте код ниже, чтобы ${escapeHtml(action)}.`, codeBlock(code)), `${kind} code for ${email}: ${code}`)
}
