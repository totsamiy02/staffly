import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { patchPicomatch, patchedHash, version } from './patches/picomatch-4.0.7.mjs'

export async function applyDependencyPatches(root, { check = false, requireAll = false } = {}) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const packages = Object.keys(lock.packages ?? {}).filter(key => /(?:^|\/)node_modules\/picomatch$/.test(key))
  let installed = 0
  for (const directory of packages) {
    const target = path.resolve(root, directory)
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Dependency patch path escapes the project')
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
    } catch (error) {
      // Omitted dev dependencies are absent in a production-only installation.
      if (error.code === 'ENOENT' && !requireAll) continue
      throw error
    }
    if (manifest.name !== 'picomatch' || manifest.version !== version) {
      throw new Error(`Review picomatch ${manifest.version}: this patch is pinned to ${version}`)
    }
    const file = path.join(target, 'lib', 'parse.js')
    const source = await readFile(file, 'utf8')
    const patched = patchPicomatch(source)
    if (check && createHash('sha256').update(source).digest('hex') !== patchedHash) {
      throw new Error('Picomatch security patch is missing. Run node scripts/apply-dependency-patches.mjs before using the build tools')
    }
    if (!check && patched !== source) await writeFile(file, patched)
    installed++
  }
  return installed
}

const root = fileURLToPath(new URL('../', import.meta.url))
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const installed = await applyDependencyPatches(root, { check: process.argv.includes('--check') })
  console.log(`Picomatch security patch: ${installed} installed package(s) verified`)
}
