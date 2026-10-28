import { writeFile } from 'node:fs/promises'
import { prisma } from '../../db.ts'
import { buildReport, reportWorkbook } from './report-service.ts'
import { reportBody } from './report-schemas.ts'

try {
  const job = await prisma.reportExport.findUniqueOrThrow({ where: { id: process.argv[2] } })
  const report = await buildReport(job.userId, job.organizationId, reportBody.parse(job.input), new Date(), 'reports.export')
  await writeFile(process.argv[3], await reportWorkbook(report), { mode: 0o600, flag: 'wx' })
} catch { process.exitCode = 1 }
finally { await prisma.$disconnect() }
