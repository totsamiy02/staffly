import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { z } from 'zod'

if(process.env.NODE_ENV!=='test'&&existsSync('src/server/.env'))loadEnvFile('src/server/.env')
const args=process.argv.slice(2), action=args.find(a=>!a.startsWith('--'))
const option=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)
if(!['grant','revoke','status'].includes(action??'')||(!option('user-id')&&!option('email'))||(option('user-id')&&option('email'))){
  console.log('Usage: npm run admin:access -- grant|revoke|status --email=you@example.org\n       npm run admin:access -- grant|revoke|status --user-id=UUID\nUses ADMIN_MANAGEMENT_DATABASE_URL, MIGRATION_DATABASE_URL, or local development DATABASE_URL. No passwords/PINs are generated.')
  process.exitCode=1
}else{
 const raw=process.env.ADMIN_MANAGEMENT_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||(process.env.NODE_ENV!=='production'?process.env.DATABASE_URL:undefined)
 if(!raw)throw new Error('Set the operator-only ADMIN_MANAGEMENT_DATABASE_URL')
 const db=new Client({connectionString:raw,statement_timeout:10000})
 try{
  await db.connect()
  const id=option('user-id'),email=option('email')?.trim().toLowerCase()
  if(id)z.uuid().parse(id)
  if(email)z.email().parse(email)
  const {rows:[user]}=await db.query('SELECT id,email_verified_at,deleted_at,password_hash IS NOT NULL AS password_set FROM public.users WHERE '+(id?'id=$1':'email=$1'),[id||email])
  if(!user||user.deleted_at||!user.email_verified_at)throw new Error('An existing active account with confirmed email is required')
  if(action==='grant'&&!user.password_set)throw new Error('Set an account password in Staffly security settings before granting administrative access')
  if(action!=='status'){
   await db.query('BEGIN')
   // Only an operator role may mutate this table; gateway/application roles fail.
   if(action==='grant')await db.query('INSERT INTO staffly_admin.accounts(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET enabled=true,version=staffly_admin.accounts.version+1,granted_at=now(),revoked_at=NULL',[user.id])
   else await db.query('UPDATE staffly_admin.accounts SET enabled=false,version=version+1,revoked_at=now() WHERE user_id=$1',[user.id])
   await db.query('UPDATE staffly_admin.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[user.id])
   await db.query('UPDATE staffly_admin.challenges SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[user.id])
   await db.query("INSERT INTO staffly_admin.audit_events(id,user_id,action,outcome) VALUES($1,$2,$3,'SUCCEEDED')",[randomUUID(),user.id,action==='grant'?'ACCESS_GRANTED':'ACCESS_REVOKED'])
   await db.query('COMMIT')
  }
  const {rows:[grant]}=await db.query('SELECT enabled,granted_at,revoked_at FROM staffly_admin.accounts WHERE user_id=$1',[user.id])
  console.log(JSON.stringify({userId:user.id,admin:Boolean(grant?.enabled),grantedAt:grant?.granted_at??null,revokedAt:grant?.revoked_at??null},null,2))
 }catch(error){await db.query('ROLLBACK').catch(()=>{});console.error(error instanceof Error&&'code'in error?`Administrative command failed (${String(error.code)}). Use the schema owner connection after migrations; no secrets are printed.`:error instanceof Error?error.message:'Administrative command failed');process.exitCode=1}
 finally{await db.end()}
}
