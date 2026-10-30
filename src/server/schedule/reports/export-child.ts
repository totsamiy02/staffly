import { readFile, writeFile } from 'node:fs/promises'
import { deserialize } from 'node:v8'
import { reportWorkbook } from './report-workbook.ts'
import type { BuiltReport } from './report-service.ts'

// Render only the authorized snapshot. This process never imports the database
// or needs application, mail or object-storage credentials, including in production.
try {
  const report = deserialize(await readFile(process.argv[2])) as BuiltReport
  await writeFile(process.argv[3], await reportWorkbook(report), { mode: 0o600, flag: 'wx' })
} catch { process.exitCode = 1 }
