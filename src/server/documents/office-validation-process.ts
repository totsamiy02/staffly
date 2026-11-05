import { processFile } from '../file-processing/client.ts'

export async function validateOfficeIsolated(contents: Buffer, extension: string) {
  await processFile('office', extension, contents)
}
