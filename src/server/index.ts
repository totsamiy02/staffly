import express from 'express'
import pg from 'pg'

const { Pool } = pg
const rawUrl = process.env.DATABASE_URL
if (!rawUrl) throw new Error('DATABASE_URL is missing in src/server/.env')

// The existing URL includes Prisma's schema parameter, which pg does not use.
const databaseUrl = new URL(rawUrl)
databaseUrl.searchParams.delete('schema')
const pool = new Pool({ connectionString: databaseUrl.toString() })
const app = express()

app.get('/api/database-status', async (_request, response) => {
  try {
    const result = await pool.query<{ database: string; server_time: Date }>(
      'SELECT current_database() AS database, now() AS server_time',
    )
    response.json({ connected: true, ...result.rows[0] })
  } catch (error) {
    console.error('Database connection failed:', error)
    response.status(503).json({ connected: false, message: 'Не удалось подключиться к базе данных' })
  }
})

const port = Number(process.env.PORT || 3001)
app.listen(port, () => console.log(`Staffly API: http://localhost:${port}`))
