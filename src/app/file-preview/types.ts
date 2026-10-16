/** Shared, inert preview data. No HTML, formulas, links or storage paths are executed. */
export const SHEET_PREVIEW_MIME = 'application/vnd.staffly.sheet+json'
export type PreviewCell = { text: string; bold?: boolean; italic?: boolean; color?: string; background?: string; align?: 'left' | 'center' | 'right'; note?: string }
export type PreviewSheet = {
  name: string; hidden: boolean; rows: number; columns: number
  cells: Record<string, PreviewCell>
  merges: Array<{ top: number; left: number; bottom: number; right: number }>
  widths: Record<string, number>
}
export type WorkbookPreview = { kind: 'workbook'; sheets: PreviewSheet[]; warnings: string[] }
export function columnLabel(index: number): string {
  let value = index, label = ''
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26) }
  return label
}
export const LEGACY_PREVIEW_MIME = 'application/vnd.staffly.legacy+json'
export type LegacyPreview = { kind: 'document' | 'slides'; pages: string[]; warning: string }
