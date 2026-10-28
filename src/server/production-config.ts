export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return
  if (env.DB_TIMEZONE !== 'UTC') throw new Error('New production databases require DB_TIMEZONE=UTC; convert and verify legacy dates before importing existing data')
  const secret = (name: string) => {
    const value = env[name] ?? ''
    if (value.length < 32 || new Set(value).size < 12 || /replace|change.?me|example|your.?secret/i.test(value)) throw new Error(`${name} must be an independent random secret of at least 32 characters`)
    return value
  }
  const jwt = secret('JWT_SECRET'), invite = secret('INVITE_CODE_SECRET'), metrics = secret('METRICS_TOKEN')
  if (new Set([jwt, invite, metrics]).size !== 3) throw new Error('JWT_SECRET, INVITE_CODE_SECRET and METRICS_TOKEN must be different')
  let origin: URL
  try { origin = new URL(env.APP_ORIGIN ?? '') } catch { throw new Error('APP_ORIGIN must be a public HTTPS origin') }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== env.APP_ORIGIN || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.hostname.endsWith('.example')) throw new Error('APP_ORIGIN must be a public HTTPS origin without a path or trailing slash')
  if (env.S3_ALLOW_INSECURE === 'true' || env.S3_ENDPOINT && !env.S3_ENDPOINT.startsWith('https://')) throw new Error('Production S3 connections require HTTPS')
  if (env.STORAGE_DRIVER !== 's3') throw new Error('Production replicas require shared S3 storage')
  if (!env.SMTP_USER || !env.SMTP_APP_PASSWORD) throw new Error('Production SMTP credentials are required')
}
