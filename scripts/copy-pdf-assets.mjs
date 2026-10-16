import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const packagePath = require.resolve('pdfjs-dist/package.json')
const { version } = require(packagePath)
const target = path.resolve('public/pdfjs', version)
await mkdir(target, { recursive: true })
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp(path.join(path.dirname(packagePath), folder), path.join(target, folder), { recursive: true })
