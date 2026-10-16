import assert from 'node:assert/strict'
import { it } from 'node:test'
import ExcelJS from 'exceljs'
import { Readable } from 'node:stream'
import { workbookPreview } from '../src/server/file-preview/workbook.ts'
import { preparePreview, readPreviewSource } from '../src/server/file-preview/service.ts'
import { columnLabel, SHEET_PREVIEW_MIME } from '../src/app/file-preview/types.ts'

it('reads all sheets, blanks, hidden sheets, merged cells, cached formulas, formats and notes', async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Данные')
  sheet.getCell('A1').value = 'Заголовок'; sheet.mergeCells('A1:C2')
  sheet.getCell('A3').value = 1234.5; sheet.getCell('A3').numFmt = '#,##0.00'
  sheet.getCell('B3').value = { formula: 'A3*2', result: 2469 }
  sheet.getCell('C3').value = { formula: 'A3*3' }
  sheet.getCell('D3').value = new Date('2026-10-15T00:00:00Z'); sheet.getCell('D3').numFmt = 'dd.mm.yyyy'
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FF123456' } }; sheet.getCell('A1').note = 'Примечание'
  book.addWorksheet('Пустой'); book.addWorksheet('Скрытый', { state: 'hidden' }).getCell('A1').value = 'Скрытые данные'
  const result = await workbookPreview(Buffer.from(await book.xlsx.writeBuffer()), false)
  assert.equal(result.sheets.length, 3); assert.equal(result.sheets[1].rows, 0); assert.equal(result.sheets[2].hidden, true)
  assert.deepEqual(result.sheets[0].merges, [{ top: 1, left: 1, bottom: 2, right: 3 }])
  assert.equal(result.sheets[0].cells['3:1'].text, '1,234.50')
  assert.equal(result.sheets[0].cells['3:2'].text, '2469')
  assert.equal(result.sheets[0].cells['3:3'].text, 'Нет сохранённого результата')
  assert.equal(result.sheets[0].cells['3:4'].text, '15.10.2026')
  assert.equal(result.sheets[0].cells['1:1'].note, 'Примечание')
  assert.ok(result.warnings.some(w => w.includes('нет сохранённого')))
})
it('handles CSV delimiters, BOM, quotes, multiline fields and does not execute formula-looking values', async () => {
  for (const delimiter of [',', ';', '\t', '|']) {
    const source = '\ufeffsep=' + delimiter + '\r\nИмя' + delimiter + 'Заметка\r\n"Анна"' + delimiter + '"строка 1\nстрока 2"\r\nИван' + delimiter + '=1+1'
    const { sheets } = await workbookPreview(Buffer.from(source), true)
    assert.equal(sheets[0].rows, 3); assert.equal(sheets[0].columns, 2)
    assert.equal(sheets[0].cells['2:2'].text, 'строка 1\nстрока 2'); assert.equal(sheets[0].cells['3:2'].text, '=1+1')
  }
  assert.equal((await workbookPreview(Buffer.from('name;note\nA;"x,y"'), true)).sheets[0].columns, 2)
})
it('rejects oversized sheets explicitly and preserves dates in the 1904 date system', async () => {
  const book = new ExcelJS.Workbook(); book.properties.date1904 = true
  const sheet = book.addWorksheet('Даты'); sheet.getCell('A1').value = new Date('2026-10-15T00:00:00Z'); sheet.getCell('A1').numFmt = 'dd.mm.yyyy'
  assert.equal((await workbookPreview(Buffer.from(await book.xlsx.writeBuffer()), false)).sheets[0].cells['1:1'].text, '15.10.2026')
  sheet.getCell('A50001').value = 'за пределом'
  await assert.rejects(workbookPreview(Buffer.from(await book.xlsx.writeBuffer()), false), /слишком велика/)
})
it('prepares CSV in a bounded child process and coalesces repeated requests', async () => {
  const bytes = Buffer.from('name,value\nAnna,10')
  const [a, b] = await Promise.all([preparePreview(bytes, 'sample.csv', 'org1'), preparePreview(bytes, 'sample.csv', 'org1')])
  assert.equal(a, b); assert.equal(a.mime, SHEET_PREVIEW_MIME)
  assert.equal(JSON.parse(a.bytes.toString()).sheets[0].cells['2:1'].text, 'Anna')
  const c = await preparePreview(bytes, 'sample.csv', 'org2'); assert.notEqual(a, c)
})
it('bounds input streams and renders column labels past Z', async () => {
  await assert.rejects(readPreviewSource(Readable.from([Buffer.alloc(20)]), 10), /слишком велик/)
  assert.equal(columnLabel(26), 'Z'); assert.equal(columnLabel(27), 'AA'); assert.equal(columnLabel(512), 'SR')
})

it('reads legacy XLS sheets without installed desktop software', async () => {
  const XLSX = await import('xlsx'), { xlsPreview } = await import('../src/server/file-preview/xls.ts')
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Имя', 'Число'], ['Анна', 42]]), 'Первый'); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Пустой')
  const bytes = XLSX.write(book, { bookType: 'biff8', type: 'buffer' }) as Buffer
  const preview = xlsPreview(bytes)
  assert.deepEqual(preview.sheets.map(sheet => sheet.name), ['Первый', 'Пустой']); assert.equal(preview.sheets[0].cells['2:2'].text, '42')
  assert.equal(JSON.parse((await preparePreview(bytes, 'book.xls', 'test')).bytes.toString()).sheets.length, 2)
})
it('resolves binary PPT slide order and ignores obsolete text outside current slides', async () => {
  const { legacySlidesFixture } = await import('./helpers/preview-fixtures.ts'), { pptSlides } = await import('../src/server/file-preview/legacy.ts')
  const bytes = await legacySlidesFixture()
  assert.deepEqual(pptSlides(bytes), ['Первый слайд\n\nДополнительный текст', 'Второй слайд'])
  const prepared = JSON.parse((await preparePreview(bytes, 'slides.ppt', 'test')).bytes.toString())
  assert.equal(prepared.kind, 'slides'); assert.equal(prepared.pages.length, 2)
  assert.throws(() => pptSlides(Buffer.alloc(512)))
})
it('accepts ordinary XLSX directory entries but still rejects embedded active files', async () => {
  const { validateDocumentFile, documentMimeTypes } = await import('../src/server/documents/file-validation.ts')
  const book = new ExcelJS.Workbook(); book.addWorksheet('Лист').getCell('A1').value = 'данные'
  await validateDocumentFile(Buffer.from(await book.xlsx.writeBuffer()), documentMimeTypes.xlsx, 'book.xlsx')
  const { previewZip, wordFixture } = await import('./helpers/preview-fixtures.ts')
  await validateDocumentFile(wordFixture(), documentMimeTypes.docx, 'book.docx')
  await assert.rejects(validateDocumentFile(previewZip([['_rels/', 'unexpected data']]), documentMimeTypes.docx, 'bad.docx'))
})

it('opens valid XLSX with prefixed workbook XML through the API preview worker', async () => {
  const { default: JSZip } = await import('jszip')
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Первый')
  sheet.getCell('A1').value = 'Тест & <значение>'; sheet.mergeCells('A1:B1')
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263746' } }
  sheet.getCell('A2').value = { formula: '1+2', result: 3 }
  sheet.getCell('B2').value = new Date('2026-10-15T00:00:00Z'); sheet.getCell('B2').numFmt = 'yyyy-mm-dd'
  sheet.addTable({ name: 'Example', ref: 'A4', columns: [{ name: 'Name' }, { name: 'Value' }], rows: [['safe', 2]] })
  book.addWorksheet('Пустой'); book.addWorksheet('Скрытый', { state: 'hidden' }).getCell('A1').value = 'Архив'
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer())
  for (const part of ['xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    const xml = await zip.file(part)!.async('string')
    zip.file(part, xml.replace(/xmlns="http:\/\/schemas.openxmlformats.org\/spreadsheetml\/2006\/main"/, 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, '<$1x:$2'))
  }
  const rels = 'xl/worksheets/_rels/sheet1.xml.rels'
  zip.file(rels, (await zip.file(rels)!.async('string')).replace('Target="../tables/table1.xml"', 'Target="/xl/tables/table1.xml"'))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const result = JSON.parse((await preparePreview(bytes, 'prefixed.xlsx', 'namespace-test')).bytes.toString())
  assert.deepEqual(result.sheets.map((sheet: { name: string }) => sheet.name), ['Первый', 'Пустой', 'Скрытый'])
  assert.equal(result.sheets[0].cells['1:1'].text, 'Тест & <значение>')
  assert.equal(result.sheets[0].cells['1:1'].bold, true)
  assert.equal(result.sheets[0].cells['1:1'].color, '#FFFFFF')
  assert.equal(result.sheets[0].cells['1:1'].background, '#263746')
  assert.equal(result.sheets[0].cells['2:1'].text, '3')
  assert.equal(result.sheets[0].cells['5:1'].text, 'safe')
  assert.equal(result.sheets[0].cells['2:2'].text, '2026-10-15')
  assert.deepEqual(result.sheets[0].merges, [{ top: 1, left: 1, bottom: 1, right: 2 }])
  assert.equal(result.sheets[1].rows, 0); assert.equal(result.sheets[2].hidden, true)
})
