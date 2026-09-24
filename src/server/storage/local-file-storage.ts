import { chmod, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const storageRoot = path.resolve(process.env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), 'storage'))
const objectKeyPattern = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/[a-f0-9-]+\.(?:webp|jpg|png|pdf)$/

function objectPath(objectKey: string) {
  if (!objectKeyPattern.test(objectKey)) throw new Error('Invalid local storage object key')
  const resolved = path.resolve(storageRoot, objectKey)
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Object key escapes storage root')
  return resolved
}

export async function writeObject(objectKey: string, contents: Buffer) {
  const destination = objectPath(objectKey)
  const temporary = `${destination}.${randomUUID()}.tmp`
  await mkdir(path.dirname(destination), { recursive: true })
  await mkdir(storageRoot, { recursive: true, mode: 0o700 })
  await chmod(storageRoot, 0o700)
  await chmod(path.dirname(destination), 0o700)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function readObject(objectKey: string) {
  return readFile(objectPath(objectKey))
}

export async function deleteObject(objectKey: string) {
  const target = objectPath(objectKey)
  try {
    await unlink(target)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  let directory = path.dirname(target)
  while (directory !== storageRoot) {
    try { await rmdir(directory) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { directory = path.dirname(directory); continue }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOTEMPTY') break
      throw error
    }
    directory = path.dirname(directory)
  }
}
