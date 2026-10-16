import { crc32, deflateRawSync } from 'node:zlib'
/** Minimal genuine OOXML fixtures; no user files or third-party content. */
export function previewZip(entries: Array<[string, string]>) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const [name, text] of entries) {
    const body = Buffer.from(text), packed = deflateRawSync(body), filename = Buffer.from(name), header = Buffer.alloc(30), record = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10); record.writeUInt32LE(crc32(body), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42)
    const local = Buffer.concat([header, filename, packed]); locals.push(local); central.push(Buffer.concat([record, filename])); offset += local.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const relationships = (items: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
export function wordFixture() {
  return previewZip([
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', relationships(relation('r1', 'officeDocument', 'word/document.xml'))],
    ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>Первые дни в команде</w:t></w:r></w:p><w:p><w:r><w:t>Добро пожаловать! Проверьте расписание и познакомьтесь с командой.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Вторая страница</w:t></w:r></w:p><w:p><w:r><w:t>Правила работы и контакты руководителя смены.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>'],
  ])
}
/** Small binary PPT with a current persist directory, two slides and an obsolete text record. */
export async function legacySlidesFixture() {
  const CFB = await import('cfb')
  const rec = (type: number, body: Buffer, flags = 0) => { const header = Buffer.alloc(8); header.writeUInt16LE(flags); header.writeUInt16LE(type, 2); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]) }
  const persist = (id: number) => { const body = Buffer.alloc(20); body.writeUInt32LE(id); return rec(1011, body) }
  const text = (value: string) => rec(4000, Buffer.from(value, 'utf16le'))
  const doc = rec(1000, rec(4080, Buffer.concat([persist(2), text('Первый слайд'), persist(3), text('Второй слайд')]), 15), 15)
  const slide1 = rec(1006, rec(0xf00d, text('Дополнительный текст')), 15), slide2 = rec(1006, Buffer.alloc(0), 15)
  const obsolete = text('Удалённый слайд не должен отображаться')
  const directoryOffset = doc.length + slide1.length + slide2.length + obsolete.length
  const entries = Buffer.alloc(16); entries.writeUInt32LE((3 << 20) | 1); entries.writeUInt32LE(0, 4); entries.writeUInt32LE(doc.length, 8); entries.writeUInt32LE(doc.length + slide1.length, 12)
  const directory = rec(6002, entries), editOffset = directoryOffset + directory.length
  const edit = Buffer.alloc(28); edit.writeUInt32LE(directoryOffset, 12); edit.writeUInt32LE(1, 16)
  const user = Buffer.alloc(28); user.writeUInt32LE(0xe391c05f, 12); user.writeUInt32LE(editOffset, 16)
  const file = CFB.utils.cfb_new({ root: 'Root Entry' }); CFB.utils.cfb_add(file, 'PowerPoint Document', Buffer.concat([doc, slide1, slide2, obsolete, directory, rec(4085, edit)])); CFB.utils.cfb_add(file, 'Current User', user)
  return Buffer.from(CFB.write(file, { type: 'buffer' }))
}
