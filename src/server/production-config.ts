import path from 'node:path'

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return
  if (env.DB_TIMEZONE !== 'UTC') throw new Error('New production databases require DB_TIMEZONE=UTC; convert and verify legacy dates before importing existing data')
  if (env.DATA_PURGE_ENABLED !== undefined && !['true', 'false'].includes(env.DATA_PURGE_ENABLED)) throw new Error('DATA_PURGE_ENABLED must be true or false')
  if (env.EMAIL_DELIVERY_PAUSED !== undefined && !['true', 'false'].includes(env.EMAIL_DELIVERY_PAUSED)) throw new Error('EMAIL_DELIVERY_PAUSED must be true or false')
  if (env.DATA_PURGE_ENABLED === 'true' && Number(env.DB_POOL_MAX ?? 10) < 2) throw new Error('Data retention requires DB_POOL_MAX >= 2')
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
  if (env.STORAGE_DRIVER === 'local') {
    // A shared local volume is suitable only for replicas on the same host.
    // Explicit opt-in prevents an accidental per-container ./storage fallback.
    if (env.LOCAL_STORAGE_SHARED !== 'true' || !env.LOCAL_STORAGE_ROOT || !path.isAbsolute(env.LOCAL_STORAGE_ROOT) || path.resolve(env.LOCAL_STORAGE_ROOT) === path.parse(env.LOCAL_STORAGE_ROOT).root) throw new Error('Production local storage requires LOCAL_STORAGE_SHARED=true and an absolute LOCAL_STORAGE_ROOT on a shared volume')
  } else if (env.STORAGE_DRIVER !== 's3') throw new Error('Production requires s3 or explicitly configured shared local storage')
  if (!env.SMTP_USER || !env.SMTP_APP_PASSWORD) throw new Error('Production SMTP credentials are required')
}
