import assert from 'node:assert/strict'
import { isIP } from 'node:net'
import { writeFile, rename, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Download only Cloudflare's published ranges. This prepares Nginx trust rules;
// it does not publish a site, reload Nginx, or change any firewall.
const groups = await Promise.all([4, 6].map(async version => {
  const response = await fetch(`https://www.cloudflare.com/ips-v${version}`, { signal: AbortSignal.timeout(15000), redirect: 'error' })
  assert(response.ok, 'Could not download official Cloudflare IP ranges')
  const body = await response.text()
  assert(body.length < 32768, 'Unexpected IP list size')
  const ranges = body.trim().split(/\s+/)
  assert(ranges.length >= 2 && ranges.length <= 100, 'Unexpected number of IP ranges')
  for (const range of ranges) {
    const [address, prefix, extra] = range.split('/')
    assert(isIP(address) === version && extra === undefined && /^\d{1,3}$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (version === 4 ? 32 : 128), 'Invalid network in IP list')
  }
  return ranges
}))
const ranges = [...new Set(groups.flat())]
const target = fileURLToPath(new URL('../deploy/cloudflare-realip.conf', import.meta.url)), temporary = target + '.tmp'
try {
  await writeFile(temporary, `# Official ranges downloaded ${new Date().toISOString()}.\n# Restrict origin access at the firewall and authenticate your own Cloudflare zone.\n${ranges.map(range => `set_real_ip_from ${range};`).join('\n')}\nreal_ip_header CF-Connecting-IP;\nreal_ip_recursive off;\n`, { flag: 'wx', mode: 0o644 })
  await rename(temporary, target)
} finally { await rm(temporary, { force: true }) }
console.log(`Prepared ${ranges.length} trusted ranges. Validate nginx -t before reloading. Firewall and CDN activation remain separate.`)
