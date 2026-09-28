import assert from 'node:assert/strict'
import { it } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import sharp from 'sharp'
import { supportsPreview, validateDocumentFile, MAX_DOCUMENT_BYTES, documentMimeTypes } from '../src/server/documents/file-validation.ts'
import { metadataSchema, assignSchema } from '../src/server/documents/schemas.ts'

function zip(entries: Array<[string, string]>) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const [name, value] of entries) {
    const body = Buffer.from(value), packed = deflateRawSync(body), filename = Buffer.from(name), header = Buffer.alloc(30), record = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10); record.writeUInt32LE(crc32(body), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42)
    const local = Buffer.concat([header, filename, packed]); locals.push(local); central.push(Buffer.concat([record, filename])); offset += local.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const wordParts: Array<[string, string]> = [['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ['_rels/.rels', '<Relationships/>'], ['word/document.xml', '<w:document/>']]
it('validates allowed signatures, MIME and extension while rejecting disguised active formats and paths', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%%EOF')
  assert.equal((await validateDocumentFile(pdf, 'application/pdf', encodeURIComponent('Приказ.pdf'))).extension, 'pdf')
  await validateDocumentFile(Buffer.from('имя,дата\nАнна,2026-01-01'), 'text/csv', 'team.csv')
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer()
  await validateDocumentFile(image, 'image/png', 'team.png')
  for (const [body, mime, name] of [[pdf, 'application/pdf', 'bad.exe'], [pdf, 'image/png', 'bad.png'], [image, 'application/pdf', 'bad.pdf'], [Buffer.from('<html>bad</html>'), 'text/plain', 'bad.txt'], [pdf, 'application/pdf', '../bad.pdf'], [pdf, 'application/pdf', 'bad%00.pdf'], [Buffer.alloc(0), 'application/pdf', 'empty.pdf'], [Buffer.alloc(MAX_DOCUMENT_BYTES + 1), 'application/pdf', 'large.pdf']] as const) await assert.rejects(() => validateDocumentFile(body, mime, name))
})
it('accepts an OOXML package but refuses arbitrary ZIP, macros, traversal and corrupt compressed data', async () => {
  await validateDocumentFile(zip(wordParts), documentMimeTypes.docx, 'policy.docx')
  for (const contents of [zip([['plain.txt', 'not office']]), zip([...wordParts, ['word/vbaProject.bin', 'macro']]), zip([...wordParts, ['../bad.xml', 'bad']]), zip([...wordParts, ['secret.zip', 'archive']]), zip(wordParts).subarray(0, -1)]) await assert.rejects(() => validateDocumentFile(contents, documentMimeTypes.docx, 'policy.docx'))
  const corrupt = zip(wordParts); corrupt[45] ^= 0xff
  await assert.rejects(() => validateDocumentFile(corrupt, documentMimeTypes.docx, 'policy.docx'))
})
it('rejects fake legacy Office headers and bounds text preview', async () => {
  const fake = Buffer.alloc(1024); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(fake); fake.write('WordDocument', 200, 'utf16le')
  await assert.rejects(() => validateDocumentFile(fake, documentMimeTypes.doc, 'fake.doc'))
  assert.equal(supportsPreview('text/plain', 1024 * 1024 + 1), false)
  assert.equal(supportsPreview(documentMimeTypes.docx, 1000), false)
  assert.equal(supportsPreview('application/pdf', 2000), true)
  assert.equal(metadataSchema.safeParse({ displayName: 'Private', visibility: 'PRIVATE_MEMBER' }).success, false)
  assert.equal(assignSchema.safeParse({ recipients: 'all', deadline: '2026-02-30' }).success, false)
})
