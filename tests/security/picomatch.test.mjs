import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { applyDependencyPatches } from '../../scripts/apply-dependency-patches.mjs'
import { changes, patchPicomatch } from '../../scripts/patches/picomatch-4.0.7.mjs'

const require = createRequire(import.meta.url)
const modulePath = require.resolve('picomatch')

// Match in a disposable process: the vulnerable version must never hang the
// test runner itself. The input is deliberately long enough to expose ReDoS.
test('repeated single-branch extglobs reject malicious paths without blocking the event loop', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module'
    import assert from 'node:assert/strict'
    const require = createRequire(import.meta.url)
    const picomatch = require(process.argv[1])
    const patterns = [
      '+(*a)', '*(*a)', '+(a*)b', '*(a*)b', '+(*)b', '*(*)b', '+(a*b)c', '*(a*b)c',
      '+(*[ab])', '+(*?a)', '+(@(*a))', '+(*(ab)c)', '+(a*|b)c', '+(ab|abab)',
    ]
    for (const options of [{}, { capture: true }, { windows: true }, { dot: true }]) {
      for (const pattern of patterns) {
        const matcher = picomatch(pattern, options)
        assert.equal(matcher('a'.repeat(128) + '!'), false, JSON.stringify({pattern, options}))
        assert.equal(matcher('ab'.repeat(128) + '!'), false, JSON.stringify({pattern, options}))
      }
    }
  `, modulePath], { timeout: 2000, encoding: 'utf8' })
  assert.equal(result.error, undefined, `Matcher blocked or failed: ${result.error?.message}`)
  assert.equal(result.status, 0, result.stderr)
})

test('ordinary glob patterns and safe repeated extglobs retain their matching behaviour', () => {
  const picomatch = require('picomatch')
  const cases = [
    ['src/app/main.tsx', 'src/**/*.{ts,tsx}', true],
    ['src/app/main.js', 'src/**/*.{ts,tsx}', false],
    ['node_modules/vite/index.js', '**/node_modules/**', true],
    ['.env', '*', false],
    ['.env', '*', true, { dot: true }],
    ['foo.js', '+(*.js)', true],
    ['foo.jsbar.js', '+(*.js)', true],
    ['foo.ts', '+(*.js)', false],
    ['aaac', '+(*)c', true],
    ['aaab', '+(*a)', false],
    ['aaa', '+(*a)', true],
    ['ababb', '+(a*b)', true],
    ['abab', '+(ab)', true],
    ['abc', '+(ab)', false],
    ['abc.js', '*(*.js)', true],
    ['file.txt', '!(*.js)', true],
    ['file.js', '!(*.js)', false],
  ]
  for (const [input, pattern, expected, options] of cases) {
    assert.equal(picomatch.isMatch(input, pattern, options), expected, `${pattern}: ${input}`)
  }
  assert(picomatch(['*.js', '*.ts'])('main.ts'))
  assert.equal(picomatch.scan('src/**/*.{ts,tsx}').base, 'src')
  assert.equal(picomatch.makeRe('src/*.ts').test('src/main.ts'), true)
  assert.equal(picomatch.compileRe(picomatch.parse('src/*.ts')).test('src/main.ts'), true)
})

test('collapsed repetition preserves short-input semantics across dot, Windows and Bash modes', () => {
  const picomatch = require('picomatch')
  const patterns = ['+(*)', '+(*a)', '*(*a)', '+(a*)', '+(a*b)', '*(*.js)', 'x+(*a)y', '+(*)c']
  const inputs = ['', 'a', 'aa', 'ab', 'a.a', '.a', 'a/b', 'abc', 'axbayb', 'foo.js', 'foo.ts', 'xaay']
  for (const options of [{}, { dot: true }, { windows: true }, { bash: true }]) {
    for (const pattern of patterns) {
      for (const input of inputs) {
        assert.deepEqual(
          picomatch.makeRe(pattern, options).exec(input),
          picomatch.makeRe(pattern, { ...options, maxExtglobRecursion: false }).exec(input),
          JSON.stringify({ pattern, input, options }),
        )
      }
    }
  }
  assert.deepEqual(Array.from(picomatch.makeRe('+(*a)', { capture: true }).exec('+(*a)')), ['+(*a)'])
})

test('installation patch is reproducible, idempotent and fails closed on missing, changed or unknown source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'staffly-picomatch-'))
  try {
    const directory = path.join(root, 'node_modules/picomatch')
    await mkdir(path.join(directory, 'lib'), { recursive: true })
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/picomatch': {} } }))
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'picomatch', version: '4.0.7' }))
    const parser = path.join(directory, 'lib/parse.js')
    const patched = await readFile(path.join(path.dirname(require.resolve('picomatch/package.json')), 'lib/parse.js'), 'utf8')
    const original = [...changes].reverse().reduce((source, change) => source.replace(change.after, change.before), patched)
    await writeFile(parser, original)
    await assert.rejects(applyDependencyPatches(root, { check: true }), /security patch is missing/)
    assert.equal(await readFile(parser, 'utf8'), original)
    assert.equal(await applyDependencyPatches(root), 1)
    assert.equal(await readFile(parser, 'utf8'), patched)
    assert.equal(await applyDependencyPatches(root), 1)
    assert.equal(await applyDependencyPatches(root, { check: true }), 1)
    assert.equal(await readFile(parser, 'utf8'), patched)
    assert.throws(() => patchPicomatch(patched + '\n// changed'), /Unexpected picomatch parser/)
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'picomatch', version: '4.0.8' }))
    await assert.rejects(applyDependencyPatches(root), /Review picomatch/)
    await rm(directory, { recursive: true })
    assert.equal(await applyDependencyPatches(root, { check: true }), 0)
    assert(await applyDependencyPatches(fileURLToPath(new URL('../../', import.meta.url)), { check: true }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
