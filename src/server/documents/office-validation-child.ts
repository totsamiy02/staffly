import { validateOffice, validateCompoundFile } from './office-validation.ts'

// Only bytes and the extension enter this process. No DB, SMTP or storage credentials.
const chunks: Buffer[] = []
let bytes = 0
for await (const chunk of process.stdin) {
  bytes += chunk.length
  if (bytes > 100 * 1024 * 1024) process.exit(2)
  chunks.push(chunk)
}
try {
  const contents = Buffer.concat(chunks), extension = process.argv[2]
  if (extension === 'docx' || extension === 'xlsx' || extension === 'pptx') validateOffice(contents, extension)
  else {
    if (contents.length < 512 || !contents.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) process.exit(2)
    const names = validateCompoundFile(contents)
    if (!(extension === 'doc' ? names.includes('WordDocument') : extension === 'xls' ? /Workbook|Book/.test(names) : extension === 'ppt' && names.includes('PowerPoint Document')) || /VBA|_VBA_PROJECT|ObjectPool/.test(names)) process.exit(2)
  }
} catch { process.exit(2) }
