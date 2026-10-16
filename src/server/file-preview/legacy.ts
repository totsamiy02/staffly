import * as CFB from 'cfb'
import { createRequire } from 'node:module'
import type { LegacyPreview } from '../../app/file-preview/types.ts'

// The legacy CJS package ships no TypeScript declarations. Keep its narrow contract at this boundary.
const WordExtractor = createRequire(import.meta.url)('word-extractor') as new () => {
  extract(bytes: Buffer): Promise<{ getBody(): string; getFootnotes(): string; getEndnotes(): string }>
}

export async function legacyPreview(bytes: Buffer, extension: string): Promise<LegacyPreview> {
  if (extension === 'ppt') return { kind: 'slides', pages: pptSlides(bytes), warning: 'Старый формат PPT: показан текст по слайдам. Рисунки, схемы, анимация и исходное оформление не воспроизводятся.' }
  const document = await new WordExtractor().extract(bytes)
  const body = document.getBody()
  const pages: string[] = []
  for (const section of body.split('\f')) for (let start = 0; start < Math.max(1, section.length); start += 12000) pages.push(section.slice(start, start + 12000))
  const notes = [document.getFootnotes(), document.getEndnotes()].filter(Boolean).join('\n\n')
  if (notes) pages.push(notes)
  return { kind: 'document', pages, warning: 'Старый формат DOC: показан текст и сноски. Оформление, рисунки и исходная разбивка на страницы не сохраняются; длинный текст разделён на части.' }
}

// MS-PPT §2.1.2: resolve the current persist directory, never show deleted slides or old revisions.
export function pptSlides(bytes: Buffer): string[] {
  const file = CFB.read(bytes, { type: 'buffer' })
  const source = CFB.find(file, 'PowerPoint Document'), user = CFB.find(file, 'Current User')
  if (!source || !user) throw new Error('Некорректная презентация.')
  const data = Buffer.from(source.content), current = Buffer.from(user.content)
  const fail = (): never => { throw new Error('Повреждённая или защищённая презентация.') }
  if (current.length < 20 || current.readUInt32LE(12) !== 0xe391c05f) fail()
  type RecordHeader = { start: number; end: number; type: number; version: number; instance: number }
  const record = (offset: number, limit = data.length): RecordHeader => {
    if (offset < 0 || offset + 8 > limit) fail()
    const end = offset + 8 + data.readUInt32LE(offset + 4)
    if (end > limit || end < offset) fail()
    const flags = data.readUInt16LE(offset)
    return { start: offset + 8, end, type: data.readUInt16LE(offset + 2), version: flags & 15, instance: flags >>> 4 }
  }
  const directory = new Map<number, number>(), visited = new Set<number>()
  let edit = current.readUInt32LE(16), docId = 0
  while (edit) {
    if (visited.has(edit) || visited.size > 10000) fail(); visited.add(edit)
    const entry = record(edit)
    if (entry.type !== 4085 || entry.end - entry.start < 28) fail()
    if (!docId) docId = data.readUInt32LE(entry.start + 16)
    const persist = record(data.readUInt32LE(entry.start + 12))
    if (persist.type !== 6002) fail()
    for (let cursor = persist.start; cursor < persist.end;) {
      if (cursor + 4 > persist.end) fail()
      const value = data.readUInt32LE(cursor), count = value >>> 20, id = value & 0xfffff; cursor += 4
      if (!count || cursor + count * 4 > persist.end) fail()
      for (let i = 0; i < count; i++, cursor += 4) if (!directory.has(id + i)) directory.set(id + i, data.readUInt32LE(cursor))
    }
    edit = data.readUInt32LE(entry.start + 8)
  }
  const docOffset = directory.get(docId); if (docOffset === undefined) return fail()
  const doc = record(docOffset); if (doc.type !== 1000) fail()
  const text = (r: RecordHeader) => data.subarray(r.start, r.end).toString(r.type === 4000 ? 'utf16le' : 'latin1').replace(/\r/g, '\n').replace(/\v/g, '\n')
  const collect = (start: number, end: number, depth = 0): string[] => {
    if (depth > 32) return fail()
    const values: string[] = []
    for (let offset = start; offset < end;) {
      const r = record(offset, end)
      if (r.type === 4000 || r.type === 4008) values.push(text(r))
      else if (r.version === 15 || r.type === 0xf00d) values.push(...collect(r.start, r.end, depth + 1))
      offset = r.end
    }
    return values
  }
  const slides: Array<{ id: number; texts: string[] }> = []
  for (let offset = doc.start; offset < doc.end;) {
    const r = record(offset, doc.end); offset = r.end
    if (r.type !== 4080 || r.instance !== 0) continue
    for (let cursor = r.start; cursor < r.end;) {
      const child = record(cursor, r.end); cursor = child.end
      if (child.type === 1011) {
        if (child.end - child.start < 20 || slides.length >= 2000) fail()
        slides.push({ id: data.readUInt32LE(child.start), texts: [] })
      } else if ([4000, 4008].includes(child.type) && slides.length) slides[slides.length - 1].texts.push(text(child))
    }
  }
  return slides.map(slide => {
    const offset = directory.get(slide.id); if (offset === undefined) return fail()
    const r = record(offset); if (r.type !== 1006) fail()
    return [...slide.texts, ...collect(r.start, r.end)].join('\n\n') || 'На слайде нет доступного текста.'
  })
}
