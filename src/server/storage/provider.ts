import type { Readable } from 'node:stream'
import { deleteObject, readObject, streamObject, writeObject } from './local-file-storage.ts'

// Business services use generated keys; only this adapter knows the physical location.
export interface StorageProvider {
  put(key: string, contents: Buffer): Promise<void>
  read(key: string): Promise<Buffer>
  stream(key: string): Promise<{ stream: Readable; size: number }>
  delete(key: string): Promise<void>
}
export const storage: StorageProvider = { put: writeObject, read: readObject, stream: streamObject, delete: deleteObject }
