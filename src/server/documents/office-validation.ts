/* oxlint-disable eslint/no-control-regex -- Reject unsafe archive paths. */
import { crc32, inflateRawSync } from 'node:zlib'
import { ApiError } from '../api-error.ts'
function invalid(): never { throw new ApiError(415, 'INVALID_DOCUMENT_FILE', 'Недопустимое содержимое Office-файла.') }

// Inspect the ZIP central directory and every entry with bounded decompression.
// OOXML is a container, not permission to upload arbitrary ZIP files or macros.
export function validateOffice(contents: Buffer, extension: 'docx' | 'xlsx' | 'pptx') {
  let end = -1
  for (let offset = contents.length - 22; offset >= Math.max(0, contents.length - 65557); offset--) if (contents.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  if (end < 0 || contents.readUInt16LE(end + 4) || contents.readUInt16LE(end + 6) || end + 22 + contents.readUInt16LE(end + 20) !== contents.length) invalid()
  const entries = contents.readUInt16LE(end + 10), centralSize = contents.readUInt32LE(end + 12), centralStart = contents.readUInt32LE(end + 16)
  if (!entries || entries > 4096 || contents.readUInt16LE(end + 8) !== entries || centralStart + centralSize !== end) invalid()
  const names = new Set<string>(); let cursor = centralStart, inflated = 0
  let contentTypes = ''
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || contents.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = contents.readUInt16LE(cursor + 8), method = contents.readUInt16LE(cursor + 10)
    const compressedSize = contents.readUInt32LE(cursor + 20), size = contents.readUInt32LE(cursor + 24)
    const nameLength = contents.readUInt16LE(cursor + 28), extraLength = contents.readUInt16LE(cursor + 30), commentLength = contents.readUInt16LE(cursor + 32)
    const local = contents.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || flags & 1 || ![0, 8].includes(method) || size > 40 * 1024 * 1024 || (inflated += size) > 100 * 1024 * 1024 || local + 30 > centralStart) invalid()
    const expectedCrc = contents.readUInt32LE(cursor + 16)
    const name = contents.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (!name || names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$)|\x00|vbaproject|activex|\.exe$|\.js$|\.html?$|\.svg$)/i.test(name)) invalid()
    const root = { docx: 'word/', xlsx: 'xl/', pptx: 'ppt/' }[extension]
    if (name !== '[Content_Types].xml' && name !== '_rels/.rels' && name !== '_rels/' && !name.startsWith('docProps/') && !name.startsWith(root)) invalid()
    if (name.endsWith('/') && size !== 0 || /embeddings\//i.test(name) && !name.endsWith('/')) invalid()
    names.add(name)
    if (contents.readUInt32LE(local) !== 0x04034b50 || contents.readUInt16LE(local + 8) !== method || contents.readUInt16LE(local + 6) !== flags) invalid()
    const localNameLength = contents.readUInt16LE(local + 26), localExtra = contents.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtra
    if (contents.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || start + compressedSize > centralStart) invalid()
    let decoded: Buffer
    try { decoded = method === 0 ? contents.subarray(start, start + compressedSize) : inflateRawSync(contents.subarray(start, start + compressedSize), { maxOutputLength: Math.max(1, size) }) } catch { invalid() }
    if (decoded.length !== size || crc32(decoded) !== expectedCrc) invalid()
    if (name === '[Content_Types].xml') contentTypes = decoded.toString('utf8')
    cursor = next
  }
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension]
  const expected = { docx: 'wordprocessingml.document.main+xml', xlsx: 'spreadsheetml.sheet.main+xml', pptx: 'presentationml.presentation.main+xml' }[extension]
  if (cursor !== end || !names.has(main) || !names.has('_rels/.rels') || !contentTypes.includes(expected) || /macroenabled/i.test(contentTypes)) invalid()
}

// Read real OLE directory entries rather than trusting stream names anywhere in bytes.
export function validateCompoundFile(contents: Buffer) {
  const major = contents.readUInt16LE(26), shift = contents.readUInt16LE(30)
  if (contents.readUInt16LE(28) !== 0xfffe || !((major === 3 && shift === 9) || (major === 4 && shift === 12))) invalid()
  const sectorSize = 2 ** shift, sectors = Math.floor(contents.length / sectorSize) - 1
  if (sectors < 1 || contents.length % sectorSize) invalid()
  const sector = (id: number) => { if (id >= sectors) invalid(); return contents.subarray((id + 1) * sectorSize, (id + 2) * sectorSize) }
  const fatCount = contents.readUInt32LE(44), difatCount = contents.readUInt32LE(72)
  if (!fatCount || fatCount > sectors || difatCount > sectors) invalid()
  const fatIds: number[] = []
  for (let offset = 76; offset < 512; offset += 4) { const id = contents.readUInt32LE(offset); if (id !== 0xffffffff) fatIds.push(id) }
  let difat = contents.readUInt32LE(68); const visitedDifat = new Set<number>()
  for (let index = 0; index < difatCount; index++) {
    if (visitedDifat.has(difat)) invalid(); visitedDifat.add(difat)
    const data = sector(difat)
    for (let offset = 0; offset < sectorSize - 4; offset += 4) { const id = data.readUInt32LE(offset); if (id !== 0xffffffff) fatIds.push(id) }
    difat = data.readUInt32LE(sectorSize - 4)
  }
  if (fatIds.length !== fatCount || new Set(fatIds).size !== fatIds.length) invalid()
  const fat = Buffer.concat(fatIds.map(sector))
  const names: string[] = []; let directory = contents.readUInt32LE(48); const visited = new Set<number>()
  while (directory !== 0xfffffffe) {
    if (visited.has(directory) || visited.size > sectors || directory * 4 + 4 > fat.length) invalid()
    visited.add(directory); const data = sector(directory)
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const type = data[offset + 66], length = data.readUInt16LE(offset + 64)
      if (!type) continue
      if (![1, 2, 5].includes(type) || length < 2 || length > 64 || length % 2 || data.readUInt16LE(offset + length - 2)) invalid()
      names.push(data.subarray(offset, offset + length - 2).toString('utf16le'))
    }
    directory = fat.readUInt32LE(directory * 4)
  }
  if (!names.includes('Root Entry')) invalid()
  return names.join(' ')
}

