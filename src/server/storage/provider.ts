import type { Readable } from 'node:stream'
import { deleteObject, readObject, streamObject, writeObject } from './local-file-storage.ts'
import { configuredS3Storage } from './s3-storage.ts'

// Business services use generated keys; only this adapter knows the physical location.
export interface StorageProvider {
  put(key: string, contents: Buffer): Promise<void>
  read(key: string): Promise<Buffer>
  stream(key: string): Promise<{ stream: Readable; size: number }>
  delete(key: string): Promise<void>
}
const driver = process.env.STORAGE_DRIVER || 'local'
if (!['local', 's3'].includes(driver)) throw new Error('STORAGE_DRIVER must be local or s3')
export const storage: StorageProvider = driver === 's3' ? configuredS3Storage() : { put: writeObject, read: readObject, stream: streamObject, delete: deleteObject }
