import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import type { StorageProvider } from './provider.ts'
import { validateObjectKey } from './local-file-storage.ts'

export function createS3Storage(client: S3Client, bucket: string): StorageProvider {
  const get = async (key: string) => {
    validateObjectKey(key)
    try { return await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })) }
    catch (error) {
      if (error && typeof error === 'object' && 'name' in error && ['NoSuchKey', 'NotFound'].includes(String(error.name))) throw Object.assign(new Error('Object not found'), { code: 'ENOENT' })
      throw error
    }
  }
  return {
    async put(key, contents) {
      validateObjectKey(key)
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: contents, ContentType: 'application/octet-stream', IfNoneMatch: '*' })) }
      catch (error) {
        if (error && typeof error === 'object' && '$metadata' in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412) throw Object.assign(new Error('Object already exists'), { code: 'EEXIST' })
        throw error
      }
    },
    async read(key) { const object = await get(key); if (!object.Body) throw new Error('Empty object response'); return Buffer.from(await object.Body.transformToByteArray()) },
    async stream(key) {
      const object = await get(key)
      if (!(object.Body instanceof Readable) || object.ContentLength === undefined) throw new Error('Invalid object stream')
      return { stream: object.Body, size: object.ContentLength }
    },
    async delete(key) { validateObjectKey(key); await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) },
  }
}

export function configuredS3Storage() {
  const bucket = process.env.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET is required for STORAGE_DRIVER=s3')
  const endpoint = process.env.S3_ENDPOINT
  if (endpoint && new URL(endpoint).protocol !== 'https:' && process.env.S3_ALLOW_INSECURE !== 'true') throw new Error('S3 requires HTTPS (or explicit S3_ALLOW_INSECURE for a private local endpoint)')
  const client = new S3Client({ region: process.env.S3_REGION || 'us-east-1', endpoint,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 30000, socketTimeout: 30000 },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 3,
    ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? { credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } } : {}),
  })
  return createS3Storage(client, bucket)
}
