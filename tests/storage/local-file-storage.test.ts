import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { deleteObject, readObject, storageRoot, writeObject } from '../../src/server/storage/local-file-storage.ts'

it('publishes exactly one complete object when writers race for the same key', async () => {
  const key = `tests/${randomUUID()}/${randomUUID()}.pdf`
  const bodies = Array.from({ length: 12 }, (_, i) => Buffer.alloc(1024 * 64, i))
  try {
    const results = await Promise.allSettled(bodies.map(body => writeObject(key, body)))
    const winner = results.findIndex(result => result.status === 'fulfilled')
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.ok(results.every(result => result.status === 'fulfilled' || result.reason.code === 'EEXIST'))
    assert.deepEqual(await readObject(key), bodies[winner])
  } finally { await deleteObject(key) }
})

it('rejects traversal and unsafe keys and refuses overwrite', async () => {
  for (const key of ['../outside.pdf', '/tmp/outside.pdf', 'users/../../outside.pdf', 'users/a/%2e%2e.pdf', 'users/a/file.exe', 'users/a/x\\y.pdf']) {
    await assert.rejects(() => writeObject(key, Buffer.from('data')))
    await assert.rejects(() => readObject(key))
    await assert.rejects(() => deleteObject(key))
  }
  const key = `tests/${randomUUID()}/${randomUUID()}.pdf`
  await writeObject(key, Buffer.from('original'))
  await assert.rejects(() => writeObject(key, Buffer.from('replacement')), /already exists/)
  assert.equal((await readObject(key)).toString(), 'original')
  assert.equal((await stat(path.join(storageRoot, key))).mode & 0o777, 0o600)
  assert.equal((await stat(path.dirname(path.join(storageRoot, key)))).mode & 0o777, 0o700)
  await deleteObject(key)
})

it('refuses directory and file symlinks without reading or deleting their targets', async () => {
  const id = randomUUID(), outside = path.join(storageRoot, `outside-${id}`), link = path.join(storageRoot, `link-${id}`)
  await mkdir(outside, { recursive: true })
  const filename = `${randomUUID()}.pdf`, target = path.join(outside, filename)
  await writeFile(target, 'protected')
  await symlink(outside, link)
  try {
    const key = `link-${id}/${filename}`
    await assert.rejects(() => readObject(key), /Unsafe/)
    await assert.rejects(() => writeObject(key, Buffer.from('overwrite')), /Unsafe/)
    await assert.rejects(() => deleteObject(key), /Unsafe/)
    const fileKey = `tests/${id}/${filename}`, filePath = path.join(storageRoot, fileKey)
    await mkdir(path.dirname(filePath), { recursive: true })
    await symlink(target, filePath)
    await assert.rejects(() => readObject(fileKey))
    await assert.rejects(() => deleteObject(fileKey), /Unsafe/)
    assert.equal((await readFile(target)).toString(), 'protected')
  } finally { await rm(link); await rm(outside, { recursive: true }); await rm(path.join(storageRoot, 'tests', id), { recursive: true, force: true }) }
})
