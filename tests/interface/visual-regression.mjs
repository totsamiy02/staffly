import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

// Keep input data and dates fixed for these cases. Other routes still produce
// diagnostic screenshots, without silently turning them into approved baselines.
const cases = new Set(['auth', 'register', 'forgot', 'account-profile', 'controls'])
export async function visualRegression({ page, root, output, browser, version, preset, name, theme, update }) {
  if (!cases.has(name) || !['desktop', 'mobile'].includes(preset)) return null
  const directory = path.join(root, 'tests/interface/baselines', `${process.platform}-${process.arch}`, browser)
  const key = `${theme}-${preset}-${name}`
  const baseline = path.join(directory, key + '.png'), metadata = path.join(directory, key + '.json')
  await page.evaluate(() => window.scrollTo(0, 0))
  const actual = await page.screenshot({ animations: 'disabled', fullPage: true, caret: 'hide' })
  await writeFile(path.join(output, `${browser}-${key}-actual.png`), actual)
  const environment = { browser, version, platform: process.platform, arch: process.arch, viewport: page.viewportSize(), theme }
  if (update) {
    await mkdir(directory, { recursive: true }); await writeFile(baseline, actual); await writeFile(metadata, JSON.stringify(environment, null, 2) + '\n')
    return { browser, preset, theme, name, status: 'updated', passed: true, baseline: path.relative(root, baseline) }
  }
  let expected, recorded
  try { expected = await readFile(baseline); recorded = JSON.parse(await readFile(metadata, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { browser, preset, theme, name, passed: false, status: 'missing-baseline', baseline: path.relative(root, baseline) }
  }
  if (JSON.stringify(recorded) !== JSON.stringify(environment)) return { browser, preset, theme, name, passed: false, status: 'environment-changed', expected: recorded, actual: environment }
  const before = PNG.sync.read(expected), after = PNG.sync.read(actual)
  if (before.width !== after.width || before.height !== after.height) return { browser, preset, theme, name, passed: false, status: 'dimensions-changed', expected: [before.width, before.height], actual: [after.width, after.height] }
  const diff = new PNG({ width: after.width, height: after.height })
  const pixels = pixelmatch(before.data, after.data, diff.data, after.width, after.height, { threshold: 0.12, includeAA: false })
  const ratio = pixels / (after.width * after.height), passed = pixels <= 20
  if (!passed) await writeFile(path.join(output, `${browser}-${key}-diff.png`), PNG.sync.write(diff))
  return { browser, preset, theme, name, passed, status: passed ? 'matched' : 'changed', pixels, ratio }
}
