import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { visualRegression } from './visual-regression.mjs'

test('visual comparisons fail on missing, changed, resized or incompatible baselines', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'staffly-visual-contract-')), output = path.join(root, 'output')
  await mkdir(output)
  const png = new PNG({ width: 48, height: 48 }); png.data.fill(255)
  let actual = PNG.sync.write(png)
  const page = { evaluate: async () => undefined, viewportSize: () => ({ width: 48, height: 48 }), screenshot: async () => actual }
  const input = { page, root, output, browser: 'test', version: '1', preset: 'mobile', name: 'auth', theme: 'light' }
  try {
    assert.equal((await visualRegression(input))?.status, 'missing-baseline')
    assert.equal((await visualRegression({ ...input, update: true }))?.status, 'updated')
    assert.equal((await visualRegression(input))?.status, 'matched')
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) { const i = (y * 48 + x) * 4; png.data[i] = png.data[i + 1] = png.data[i + 2] = 0 }
    actual = PNG.sync.write(png)
    assert.equal((await visualRegression(input))?.status, 'changed')
    assert.equal((await visualRegression({ ...input, version: '2' }))?.status, 'environment-changed')
    actual = PNG.sync.write(new PNG({ width: 49, height: 48 }))
    assert.equal((await visualRegression(input))?.status, 'dimensions-changed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
