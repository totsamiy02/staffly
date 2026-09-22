import nodemailer from 'nodemailer'

export const appUrl = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const smtpUser = process.env.SMTP_USER
const smtpPassword = process.env.SMTP_APP_PASSWORD
const smtpReady = Boolean(smtpUser && smtpPassword)

if (process.env.NODE_ENV === 'production' && !smtpReady) throw new Error('SMTP_USER and SMTP_APP_PASSWORD are required in production')
if (process.env.NODE_ENV === 'development' && !smtpReady) console.log('SMTP is not configured: security codes will be printed in this terminal.')

const transport = smtpReady ? nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'smtp.yandex.ru',
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: Number(process.env.SMTP_PORT ?? 465) === 465,
  auth: { user: smtpUser?.endsWith('@yandex.ru') ? smtpUser.split('@')[0] : smtpUser, pass: smtpPassword },
}) : null

export async function deliverSecurityCode(kind: 'verification' | 'reset', email: string, code: string) {
  if (!transport) {
    if (process.env.NODE_ENV !== 'development') throw new Error('SMTP is not configured')
    console.log(`[DEV ONLY] ${kind} code for ${email}: ${code}`)
    return
  }
  const verification = kind === 'verification'
  const subject = verification ? 'Код подтверждения почты — Staffly' : 'Код восстановления пароля — Staffly'
  const heading = verification ? 'Подтвердите почту' : 'Восстановление доступа'
  const explanation = verification
    ? 'Введите этот код на странице регистрации Staffly, чтобы подтвердить адрес электронной почты.'
    : 'Введите этот код на странице восстановления Staffly, чтобы задать новый пароль.'
  await transport.sendMail({
    from: { name: 'Staffly', address: smtpUser! },
    to: email,
    subject,
    text: `Staffly\n\n${heading}\n${explanation}\n\nКод: ${code}\n\nКод действует 10 минут. Если вы не запрашивали его, просто проигнорируйте письмо.`,
    html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:32px 12px;background:#f4f4f4;color:#181818;font-family:Arial,Helvetica,sans-serif"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6e6;border-radius:16px"><tr><td style="padding:38px 40px"><div style="font-size:25px;font-weight:700;letter-spacing:-1px">Staffly</div><div style="height:1px;background:#e9e9e9;margin:28px 0"></div><h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">${heading}</h1><p style="margin:0;color:#555;font-size:15px;line-height:1.6">${explanation}</p><div style="margin:30px 0;padding:20px;border:1px solid #dedede;border-radius:12px;background:#f8f8f8;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px">${code}</div><p style="margin:0;color:#666;font-size:13px;line-height:1.6">Код действует 10 минут. Никому его не сообщайте.</p><div style="height:1px;background:#e9e9e9;margin:30px 0 20px"></div><p style="margin:0;color:#888;font-size:12px;line-height:1.6">Если вы не запрашивали код, просто проигнорируйте это письмо.<br>Автоматическое сообщение Staffly.</p></td></tr></table></body></html>`,
  })
}
