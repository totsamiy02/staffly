/** Canonical upload MIME types, shared by browser forms and server validation. */
export const documentMimeTypes = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
} as const
export const documentAccept = Object.keys(documentMimeTypes).map(ext => `.${ext}`).join(',')
export function fileExtension(name: string) { return name.split('.').at(-1)?.toLowerCase() ?? '' }
export function documentMime(name: string) { return documentMimeTypes[fileExtension(name) as keyof typeof documentMimeTypes] }
export function isSpreadsheet(name: string) { return ['xls', 'xlsx', 'csv'].includes(fileExtension(name)) }
export function isPresentation(name: string) { return ['ppt', 'pptx'].includes(fileExtension(name)) }
