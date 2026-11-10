import { verifyReleaseEvidence } from './verify-release-evidence.ts'
import { loadEnvFile } from 'node:process'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { z } from 'zod'
try{loadEnvFile('src/server/.env')}catch{}
const file=process.argv.find(v=>v.startsWith('--report='))?.slice(9),url=process.env.ADMIN_MANAGEMENT_DATABASE_URL
if(!file||!url)throw new Error('Set operator ADMIN_MANAGEMENT_DATABASE_URL and --report=path')
const check=z.object({build:z.literal(true),types:z.literal(true),lint:z.literal(true),serverTests:z.literal(true),browserTests:z.literal(true),personnelTests:z.literal(true),containerTests:z.literal(true),migrations:z.literal(true),secrets:z.literal(true)}).strict()
const schema=z.object({appVersion:z.string().regex(/^[a-f0-9]{40}$/),schemaVersion:z.string().max(100),checks:check,ci:z.object({repository:z.string().regex(/^[\w.-]+\/[\w.-]+$/),runId:z.number().int().positive(),runAttempt:z.number().int().positive()}).strict()}).strict(),report=schema.parse(JSON.parse(await readFile(file,'utf8')))
const evidence=await verifyReleaseEvidence(report.ci,report.appVersion)
const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000})
try{const current=(await pool.query('SELECT version,failed FROM staffly_admin.release_schema_state')).rows[0];if(current.failed!==0||current.version!==report.schemaVersion)throw new Error('Release check schema does not match the installation');await pool.query("INSERT INTO staffly_admin.release_checks(app_version,schema_version,checks,passed,source) VALUES($1,$2,$3,true,'operator-ci')",[report.appVersion,report.schemaVersion,JSON.stringify({...report.checks,ci:evidence})]);console.log('Release check recorded')}finally{await pool.end()}
