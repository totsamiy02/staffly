import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DAY = 86400_000
async function digest(file: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex') }
export async function registerBackupRetention(file: string, now = new Date()) {
  const metadata = { format: 'staffly-database-backup-v1', file: path.basename(file), createdAt: now.toISOString(), expiresAt: new Date(+now + 30 * DAY).toISOString(), sha256: await digest(file) }
  await writeFile(file + '.retention.json', JSON.stringify(metadata) + '\n', { flag: 'wx', mode: 0o600 })
}
// Explicit operator command: never walks parent directories, follows symlinks,
// or deletes unregistered/manual backups. Dry-run unless --apply=true.
export async function pruneBackups(directory: string, { apply = false, now = new Date() } = {}) {
  const root = path.resolve(directory), expired: string[] = [], invalid: string[] = []
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Choose a real backup directory')
  for (const name of await readdir(root)) {
    if (!name.endsWith('.dump.retention.json')) continue
    const manifest = path.join(root, name), file = name.slice(0, -'.retention.json'.length), backup = path.join(root, file)
    try {
      const stat = await lstat(manifest), backupStat = await lstat(backup)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || !backupStat.isFile() || backupStat.isSymbolicLink()) throw new Error('INVALID_FILE')
      const data = JSON.parse(await readFile(manifest, 'utf8')), created = Date.parse(data.createdAt), expires = Date.parse(data.expiresAt)
      if (data.format !== 'staffly-database-backup-v1' || data.file !== file || !Number.isFinite(created) || expires !== created + 30 * DAY || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('INVALID_MANIFEST')
      if (expires > +now) continue
      if (await digest(backup) !== data.sha256) throw new Error('BACKUP_CHANGED')
      expired.push(file)
      if (apply) { await unlink(backup); await unlink(manifest) }
    } catch { invalid.push(name) }
  }
  return { apply, retentionDays: 30, expired, invalid }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv.slice(2).find(arg => arg.startsWith('--directory='))?.slice(12)
  if (!directory) throw new Error('Pass --directory=/absolute/backup/path (dry-run); --apply=true enables deletion')
  console.log(JSON.stringify(await pruneBackups(directory, { apply: process.argv.includes('--apply=true') }), null, 2))
}
