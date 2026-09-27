import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

if (process.env.NODE_ENV === 'test' && (!process.env.LOCAL_STORAGE_ROOT || path.resolve(process.env.LOCAL_STORAGE_ROOT) === path.resolve('storage'))) throw new Error('Test storage must use an isolated LOCAL_STORAGE_ROOT')
export const storageRoot = path.resolve(process.env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), 'storage'))
const objectKeyPattern = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/[a-f0-9-]+\.(?:webp|jpg|png|pdf)$/

function objectPath(objectKey: string) {
  if (!objectKeyPattern.test(objectKey)) throw new Error('Invalid local storage object key')
  const resolved = path.resolve(storageRoot, objectKey)
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Object key escapes storage root')
  return resolved
}

function missing(error: unknown) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }

// Validate every directory, not just the lexical prefix: symlinks must not escape storage.
async function checkDirectories(target: string, create = false) {
  const parts = path.relative(storageRoot, path.dirname(target)).split(path.sep).filter(Boolean)
  let directory = storageRoot
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index <= parts.length; index++) {
    if (index) { directory = path.join(directory, parts[index - 1]); if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error }) }
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe local storage directory')
    if (create) await chmod(directory, 0o700)
  }
}

export async function writeObject(objectKey: string, contents: Buffer) {
  const destination = objectPath(objectKey)
  const temporary = `${destination}.${randomUUID()}.tmp`
  await checkDirectories(destination, true)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    try { await lstat(destination); throw Object.assign(new Error('Storage object already exists'), { code: 'EEXIST' }) } catch (error) { if (!missing(error)) throw error }
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function readObject(objectKey: string) {
  const target = objectPath(objectKey)
  await checkDirectories(target)
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { if (!(await file.stat()).isFile()) throw new Error('Unsafe local storage object'); return await file.readFile() }
  finally { await file.close() }
}

export async function deleteObject(objectKey: string) {
  const target = objectPath(objectKey)
  try { await checkDirectories(target) } catch (error) { if (missing(error)) return; throw error }
  try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe local storage object'); await unlink(target) }
  catch (error) { if (!missing(error)) throw error }
  // A durable pending-upload record also owns its interrupted atomic-write temp files.
  const prefix = path.basename(target) + '.'
  for (const entry of await readdir(path.dirname(target), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix) && /^[a-f0-9-]{36}\.tmp$/.test(entry.name.slice(prefix.length))) await unlink(path.join(path.dirname(target), entry.name))
  }
  let directory = path.dirname(target)
  while (directory !== storageRoot) {
    try { await rmdir(directory) }
    catch (error) {
      if (missing(error)) { directory = path.dirname(directory); continue }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOTEMPTY') break
      throw error
    }
    directory = path.dirname(directory)
  }
}
