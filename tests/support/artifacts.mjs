import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

/** Generated reports belong outside test sources and never overwrite another run. */
export async function createArtifactDirectory(kind, override) {
  if (!['regression', 'load', 'scale', 'edge', 'audit'].includes(kind)) throw new Error('Unknown test artifact kind')
  const now = new Date().toISOString()
  const directory = override ? path.resolve(projectRoot, override)
    : path.join(projectRoot, 'artifacts/tests', now.slice(0, 10), `${kind}-${now.slice(11, 23).replaceAll(':', '-').replace('.', '-')}-${randomUUID().slice(0, 8)}`)
  await mkdir(directory, { recursive: true })
  return directory
}

export async function writeReport(directory, value) {
  const temporary = path.join(directory, 'report.json.tmp')
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, path.join(directory, 'report.json'))
}
