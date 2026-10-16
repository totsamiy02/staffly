// A separate process keeps malformed/expensive workbooks off the API event loop.
import { readFile, writeFile } from 'node:fs/promises'
import { workbookPreview } from './workbook.ts'
import { xlsPreview } from './xls.ts'
import { legacyPreview } from './legacy.ts'
const [input, output, kind] = process.argv.slice(2)
try {
  const bytes = await readFile(input)
  const result = JSON.stringify(kind === 'xls' ? xlsPreview(bytes) : ['doc', 'ppt'].includes(kind) ? await legacyPreview(bytes, kind) : await workbookPreview(bytes, kind === 'csv'))
  if (Buffer.byteLength(result) > 24 * 1024 * 1024) throw new Error('Таблица слишком велика для предпросмотра.')
  await writeFile(output, result, { mode: 0o600 })
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message.slice(0, 1000) : 'Не удалось прочитать таблицу.')
  process.exitCode = 1
}
