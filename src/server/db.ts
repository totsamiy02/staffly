import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.ts'

const rawUrl = process.env.DATABASE_URL
if (!rawUrl) throw new Error('DATABASE_URL is missing')

const url = new URL(rawUrl)
url.searchParams.delete('schema')
if (url.hostname === 'localhost') url.hostname = '127.0.0.1'

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url.toString() }),
})
