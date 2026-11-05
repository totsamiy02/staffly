// Enumerated operations and stdin/stdout only; no application services or credentials.
const [operation, kind] = process.argv.slice(2)
const chunks: Buffer[] = []; let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > 100 * 1024 * 1024) process.exit(2)
  chunks.push(chunk)
}
try {
  const bytes = Buffer.concat(chunks)
  if (operation === 'office') {
    const { validateOffice, validateCompoundFile } = await import('../documents/office-validation.ts')
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') validateOffice(bytes, kind)
    else {
      if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new Error('Invalid Office')
      const names = validateCompoundFile(bytes)
      if (!(kind === 'doc' ? names.includes('WordDocument') : kind === 'xls' ? /Workbook|Book/.test(names) : kind === 'ppt' && names.includes('PowerPoint Document')) || /VBA|_VBA_PROJECT|ObjectPool|EncryptedPackage|EncryptionInfo/i.test(names)) throw new Error('Active Office')
    }
  } else if (operation === 'image' || operation === 'avatar') {
    const { default: sharp } = await import('sharp')
    sharp.cache(false); sharp.concurrency(1)
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 25_000_000 })
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1 || operation === 'image' && metadata.format !== kind) throw new Error('Invalid image')
    const rotated = image.rotate()
    // Re-encode every uploaded image, removing metadata and appended content.
    const output = operation === 'avatar' ? await rotated.resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer()
      : await rotated.toFormat(kind as 'jpeg' | 'png' | 'webp').toBuffer()
    if (output.length > 25 * 1024 * 1024) throw new Error('Image output limit')
    process.stdout.write(output)
  } else if (operation === 'preview') {
    const result = kind === 'xls' ? (await import('../file-preview/xls.ts')).xlsPreview(bytes)
      : kind === 'doc' || kind === 'ppt' ? await (await import('../file-preview/legacy.ts')).legacyPreview(bytes, kind)
      : await (await import('../file-preview/workbook.ts')).workbookPreview(bytes, kind === 'csv')
    const output = JSON.stringify(result)
    if (Buffer.byteLength(output) > 24 * 1024 * 1024) throw new Error('Preview output limit')
    process.stdout.write(output)
  } else throw new Error('Unknown operation')
} catch { process.exitCode = 2 }
