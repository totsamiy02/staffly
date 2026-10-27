import nodemailer from 'nodemailer'

export const appUrl = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const smtpUser = process.env.SMTP_USER
const smtpPassword = process.env.SMTP_APP_PASSWORD
const smtpReady = Boolean(smtpUser && smtpPassword)
if (process.env.NODE_ENV === 'production' && !smtpReady) throw new Error('SMTP_USER and SMTP_APP_PASSWORD are required in production')
if (process.env.NODE_ENV === 'development' && !smtpReady) console.log('SMTP is not configured: email contents will be printed in this terminal.')
const transport = smtpReady ? nodemailer.createTransport({ connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000, host: process.env.SMTP_HOST ?? 'smtp.yandex.ru', port: Number(process.env.SMTP_PORT ?? 465), secure: Number(process.env.SMTP_PORT ?? 465) === 465, auth: { user: smtpUser?.endsWith('@yandex.ru') ? smtpUser.split('@')[0] : smtpUser, pass: smtpPassword } }) : null

export type EmailContent = {
  title: string; eyebrow?: string; intro: string; organization?: string;
  fields?: Array<[string, string]>; code?: string; badge?: { text: string; tone: 'success' | 'warning' };
  action?: { label: string; path: string }; footer?: string; optional?: boolean;
}
export const escapeEmailHtml = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!)
export function renderEmail(content: EmailContent) {
  const e = escapeEmailHtml
  const href = (path: string) => { const url = new URL(path, appUrl); if (url.origin !== new URL(appUrl).origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid email action URL'); return url.href }
  const subject = `${content.title}${content.organization ? ` · ${content.organization}` : ''} — Staffly`
  const fields = content.fields?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background:#f5f6f7;border-radius:12px"><tr><td style="padding:16px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${content.fields.map(([label, value]) => `<tr><td style="padding:5px 12px 5px 0;vertical-align:top;color:#727984;font-size:13px;width:32%">${e(label)}</td><td style="padding:5px 0;vertical-align:top;color:#20242a;font-size:14px;font-weight:600;overflow-wrap:anywhere">${e(value)}</td></tr>`).join('')}</table></td></tr></table>` : ''
  const footer = content.optional ? 'Вы получаете это письмо по вашим настройкам.' : content.footer ?? 'Автоматическое сообщение Staffly.'
  const action = content.action ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td bgcolor="#171717" style="border-radius:10px;text-align:center"><a href="${e(href(content.action.path))}" style="display:inline-block;padding:14px 22px;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:10px">${e(content.action.label)}</a></td></tr></table>` : ''
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media(max-width:600px){.email-body{padding:16px 10px!important}.email-card{padding:25px 20px!important}.email-heading{font-size:25px!important}}a:focus{outline:2px solid #555;outline-offset:3px}</style></head><body class="email-body" style="margin:0;padding:32px 12px;background:#f4f4f3;color:#181818;font-family:Arial,Helvetica,sans-serif;line-height:1.6"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${e(content.intro)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e5e6e8;border-radius:16px"><tr><td class="email-card" style="padding:32px 34px"><div style="font-size:27px;font-weight:700;letter-spacing:-1px;color:#111">Staffly</div>${content.eyebrow ? `<p style="margin:23px 0 8px;color:#808690;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase">${e(content.eyebrow)}</p>` : '<div style="height:22px"></div>'}${content.badge ? `<span style="display:inline-block;padding:4px 10px;border-radius:8px;background:${content.badge.tone === 'success' ? '#eaf4ed' : '#fbecf0'};color:${content.badge.tone === 'success' ? '#3d6b4d' : '#a3425a'};font-size:12px">${e(content.badge.text)}</span>` : ''}<h1 class="email-heading" style="margin:10px 0 14px;font-size:28px;line-height:1.2;letter-spacing:-.7px;color:#111">${e(content.title)}</h1><p style="margin:0;color:#5c626d;font-size:15px;white-space:pre-line">${e(content.intro)}</p>${content.code ? `<div style="margin:26px 0 12px;padding:18px;border:1px solid #e6e7ea;border-radius:12px;background:#f5f6f7;text-align:center;font-size:34px;font-weight:700;letter-spacing:7px;color:#171717">${e(content.code.slice(0,3))} ${e(content.code.slice(3))}</div><p style="margin:0;color:#777d87;font-size:12px;text-align:center">Код действует 10 минут. Никому его не сообщайте.</p>` : ''}${fields}${action}<div style="height:1px;background:#e8e9eb;margin:26px 0 18px"></div><p style="margin:0;color:#858a94;font-size:12px">${e(footer)}</p>${content.optional ? `<p style="margin:5px 0 0;font-size:12px"><a href="${e(href('/app/settings?section=notifications'))}" style="color:#656d79;text-decoration:underline">Настроить уведомления</a></p>` : ''}</td></tr></table></td></tr></table></body></html>`
  const text = [content.title, content.intro, content.code ? `Код: ${content.code}. Действует 10 минут.` : '', ...(content.fields ?? []).map(([label, value]) => `${label}: ${value}`), content.action ? `${content.action.label}: ${href(content.action.path)}` : '', footer, content.optional ? `Настроить уведомления: ${href('/app/settings?section=notifications')}` : ''].filter(Boolean).join('\n')
  return { subject, html, text }
}
export async function sendPreparedMail(email: string, message: ReturnType<typeof renderEmail>, id?: string) {
  if (!transport) {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new Error('SMTP is not configured')
    if (process.env.NODE_ENV === 'development') console.log(`[DEV ONLY] Email to ${email}: ${message.text}`)
    return
  }
  await transport.sendMail({ from: { name: 'Staffly', address: smtpUser! }, to: email, ...message, ...(id ? { messageId: `<${id}@${new URL(appUrl).hostname}>` } : {}) })
}
export const deliverEmail = (email: string, content: EmailContent) => sendPreparedMail(email, renderEmail(content))
export function deliverSecurityCode(kind: 'verification' | 'reset' | 'email-change', email: string, code: string) {
  if (kind === 'email-change') return deliverEmail(email, { title: 'Подтвердите новую почту', eyebrow: 'Безопасность', intro: 'Введите код в настройках безопасности Staffly, чтобы назначить этот адрес почтой вашего аккаунта.', code, footer: 'Если вы не меняете почту в Staffly, проигнорируйте письмо. Без подтверждения адрес аккаунта не изменится.' })
  return deliverEmail(email, { title: kind === 'verification' ? 'Подтвердите почту' : 'Восстановление пароля', eyebrow: 'Безопасность', intro: kind === 'verification' ? 'Введите код на странице регистрации Staffly, чтобы подтвердить адрес электронной почты.' : 'Введите код на странице восстановления доступа, чтобы задать новый пароль.', code, footer: kind === 'verification' ? 'Если вы не регистрировались в Staffly, проигнорируйте письмо.' : 'Не запрашивали восстановление? Не сообщайте код. Без него пароль не изменится.' })
}
export function deliverSensitiveActionCode(kind: 'ownership' | 'deletion' | 'location', email: string, organizationName: string, code: string, targetName?: string) {
  return deliverEmail(email, { title: kind === 'ownership' ? 'Передача владения' : kind === 'location' ? 'Закрытие точки' : 'Удаление организации', eyebrow: 'Подтверждение действия', intro: kind === 'ownership' ? `Вы передаёте организацию «${organizationName}»${targetName ? ` участнику ${targetName}` : ''}. Подтвердите действие кодом.` : `Подтвердите ${kind === 'location' ? 'закрытие точки' : 'удаление организации'} «${organizationName}» кодом.`, code, footer: 'Не запрашивали это действие? Не сообщайте код и проверьте безопасность аккаунта.' })
}
export function deliverOrganizationInvitation(email: string, organizationName: string, inviterName: string, token: string, expiresAt: Date, _logoUrl: string | null = null) {
  return deliverEmail(email, { title: `Вас приглашают в «${organizationName}»`, eyebrow: 'Приглашение в команду', intro: `${inviterName} приглашает вас присоединиться к команде. Войдите или зарегистрируйтесь с указанной почтой.`, fields: [['Организация', organizationName], ['Адрес приглашения', email], ['Действует до', expiresAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК']], action: { label: 'Открыть приглашение', path: `/app?invite=${encodeURIComponent(token)}` }, footer: 'Если приглашение вам неизвестно, не принимайте его.' })
}
