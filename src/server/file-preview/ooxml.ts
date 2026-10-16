import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import { posix } from 'node:path'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')

/** ExcelJS expects unprefixed SpreadsheetML tags. Normalize namespace spelling, preserving XML values. */
export async function compatibleSpreadsheetXml(bytes: Buffer): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(bytes)
  let changed = false, total = 0
  for (const file of Object.values(zip.files)) {
    if (file.dir || !file.name.startsWith('xl/') || !/\.(xml|rels)$/.test(file.name)) continue
    const xml = await file.async('string'); total += Buffer.byteLength(xml)
    if (total > 100 * 1024 * 1024) throw new Error('Таблица слишком велика для предпросмотра.')
    const relationships = file.name.endsWith('.rels')
    if (!relationships && (!xml.includes(MAIN) || !xml.includes('xmlns:'))) continue
    const output: string[] = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on('doctype', () => { throw new Error('DTD в таблицах не поддерживается.') })
    parser.on('opentag', tag => {
      const main = tag.uri === MAIN
      output.push('<', main ? tag.local : tag.name)
      if (main) output.push(' xmlns="', MAIN, '"')
      for (const attribute of Object.values(tag.attributes)) {
        if (main && attribute.name === 'xmlns') continue
        let value = attribute.value
        if (relationships && tag.local === 'Relationship' && attribute.name === 'Target' && value.startsWith('/xl/') && zip.file(value.slice(1)) && tag.attributes.TargetMode?.value !== 'External') {
          const source = file.name.replace('/_rels/', '/').replace(/\.rels$/, '')
          value = posix.relative(posix.dirname(source), value.slice(1))
          changed = true
        }
        output.push(' ', attribute.name, '="', escapeAttribute(value), '"')
      }
      output.push('>')
      if (main && tag.prefix) changed = true
    })
    parser.on('closetag', tag => output.push('</', tag.uri === MAIN ? tag.local : tag.name, '>'))
    parser.on('text', value => output.push(escapeText(value)))
    parser.on('cdata', value => output.push(escapeText(value)))
    parser.write(xml).close()
    zip.file(file.name, output.join(''))
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer' }) : null
}
