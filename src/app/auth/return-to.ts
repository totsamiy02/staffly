// Keep OAuth/password login and invitation navigation on this application.
export function safeReturnTo(value: unknown, fallback = '/app') {
  if (typeof value !== 'string' || value.length > 2048 || !/^\/app(?:[/?#]|$)/.test(value) || value.includes('\\') || Array.from(value).some(character => character.charCodeAt(0) <= 32)) return fallback
  try {
    const url = new URL(value, 'https://staffly.invalid')
    return url.origin === 'https://staffly.invalid' && /^\/app(?:\/|$)/.test(url.pathname) ? url.pathname + url.search + url.hash : fallback
  } catch { return fallback }
}
