import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { prisma } from '../src/server/db.ts'
import { cleanupPendingFiles } from '../src/server/storage/image-service.ts'
import { readObject, storageRoot } from '../src/server/storage/local-file-storage.ts'

// Read-only by default. Cleanup uses only explicit, due database deletion records.
if (process.argv.slice(2).some(argument => argument !== '--cleanup')) throw new Error('Usage: npm run storage:audit -- [--cleanup]')
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex')
try {
  const info = await lstat(storageRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe storage root')
  const files = await prisma.storedFile.findMany({ select: { objectKey: true, size: true, checksumSha256: true, pendingDeletionAt: true } })
  const known = new Map(files.map(file => [file.objectKey, file]))
  const fixtures = new Set([
    checksum(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')),
    checksum(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer()),
  ])
  const result = { registered: 0, pendingDeletion: 0, unregistered: 0, testFixtureMatches: 0, temporary: 0, finderMetadata: 0, unsafeEntries: 0, checksumMismatch: 0, missingRegistered: 0 }
  const seen = new Set<string>()
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { result.unsafeEntries++; continue }
      if (entry.isDirectory()) { await walk(target); continue }
      if (!entry.isFile()) { result.unsafeEntries++; continue }
      const key = path.relative(storageRoot, target).split(path.sep).join('/')
      if (entry.name === '.DS_Store') { result.finderMetadata++; continue }
      if (entry.name.endsWith('.tmp')) { result.temporary++; continue }
      let contents: Buffer
      try { contents = await readObject(key) } catch { result.unsafeEntries++; continue }
      const hash = checksum(contents)
      if (fixtures.has(hash)) result.testFixtureMatches++
      const file = known.get(key)
      if (!file) { result.unregistered++; continue }
      seen.add(key); result.registered++
      if (file.pendingDeletionAt) result.pendingDeletion++
      if (contents.length !== file.size || hash !== file.checksumSha256) result.checksumMismatch++
    }
  }
  if (info) await walk(storageRoot)
  result.missingRegistered = files.filter(file => !seen.has(file.objectKey)).length
  console.log(JSON.stringify(result, null, 2))
  console.log('Unregistered and unknown files are preserved; absence from this database alone does not prove they are disposable.')
  if (process.argv.includes('--cleanup')) console.log('Explicit pending deletion cleanup:', await cleanupPendingFiles({ limit: 500 }))
} finally { await prisma.$disconnect() }
