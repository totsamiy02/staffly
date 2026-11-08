import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
type Browser={userId:string;email:string;ready:()=>Promise<unknown>;request:(path:string,body?:unknown,extra?:Record<string,string>)=>Promise<Response>}
export function workflowScenarios({account,db}:{account:(admin?:boolean)=>Promise<Browser>;db:Pool}){
 it('assigns diagnostics with separate acknowledgment, optimistic versions, bounded history and immediate revocation checks',async()=>{
  const actor=await account(),other=await account(),ordinary=await account(false);await actor.ready();await other.ready()
  const id=randomUUID(),root='/api/admin/management/work/diagnostic/'+id
  await db.query("INSERT INTO platform_request_errors(id,node_id,method,route,status,name,source,user_id) VALUES($1,$2,'POST','/probe',500,'Error','request',$3)",[id,randomUUID(),actor.userId])
  const get=()=>actor.request(root).then(r=>r.json()),assign=(assigneeId:string|null,version:number)=>actor.request(root+'/assign',{assigneeId,version,confirm:true})
  try{
   assert.equal((await get()).version,0)
   assert.equal((await ordinary.request(root)).status,403)
   assert.equal((await assign(ordinary.userId,0)).status,409)
   assert.equal((await assign(actor.userId,0)).status,200)
   let state=await get();assert.equal(state.assigneeId,actor.userId);assert.equal(state.history.total,1)
   assert.equal((await assign(other.userId,0)).status,409)
   assert.equal((await assign(actor.userId,1)).status,200);assert.equal((await get()).history.total,1)
   assert.equal((await actor.request('/api/admin/operations/support?assignment=assigned&search='+id).then(r=>r.json())).total,1)
   assert.equal((await assign(other.userId,1)).status,200)
   state=await get();assert.equal(state.history.total,2);assert.equal(state.history.items[0].actorId,actor.userId);assert.notEqual(state.history.items[0].from,'Не назначен')
   await db.query('UPDATE staffly_admin.accounts SET enabled=false WHERE user_id=$1',[other.userId])
   assert.equal((await get()).assigneeAvailable,false)
   assert.equal((await actor.request('/api/admin/operations/support?assignment=unassigned&search='+id).then(r=>r.json())).total,1)
   assert.equal((await assign(other.userId,2)).status,409)
   assert.equal((await assign(null,2)).status,200);assert.equal((await get()).history.total,3)
   assert.equal((await actor.request(root+'/assign',{assigneeId:actor.userId,version:3,confirm:true,enabled:true})).status,400)
   assert.equal((await actor.request(root+'/assign',{assigneeId:actor.userId,version:3,confirm:true},{Origin:'https://evil.example'})).status,403)
   await actor.request('/api/admin/lock',{});assert.equal((await assign(actor.userId,3)).status,423)
   assert.equal((await db.query("SELECT count(*)::int AS n FROM staffly_admin.audit_events WHERE resource_id=$1 AND action='WORK_ASSIGNED'",[id])).rows[0].n,3)
  }finally{await db.query('DELETE FROM platform_request_errors WHERE id=$1',[id])}
 })
 it('keeps alert acknowledgment distinct from responsibility and forbids changes to resolved episodes',async()=>{
  const actor=await account();await actor.ready();const id=randomUUID(),rule=(await db.query("SELECT id FROM staffly_admin.alert_rules WHERE key='API_ERRORS'")).rows[0]
  // A closed fixture is reopened inside this transaction-free scenario only.
  await db.query("INSERT INTO staffly_admin.alerts(id,rule_id,measured,threshold,first_seen_at,last_seen_at,resolved_at) VALUES($1,$2,9,5,now(),now(),now())",[id,rule.id])
  try{
   const url='/api/admin/management/work/alert/'+id
   assert.equal((await actor.request(url+'/assign',{assigneeId:actor.userId,version:0,confirm:true})).status,409)
   // Avoid interfering with an existing active episode for this rule.
   await db.query('UPDATE staffly_admin.alerts SET resolved_at=now() WHERE rule_id=$1 AND resolved_at IS NULL',[rule.id]);await db.query('UPDATE staffly_admin.alerts SET resolved_at=NULL WHERE id=$1',[id])
   assert.equal((await actor.request('/api/admin/management/alerts/'+id+'/acknowledge',{confirm:true})).status,200)
   const detail=await actor.request('/api/admin/management/alerts/'+id).then(r=>r.json());assert.equal(detail.acknowledgedBy,actor.userId);assert(detail.acknowledgedName);assert.equal(detail.assigneeName,null)
   assert.equal((await actor.request(url+'/assign',{assigneeId:actor.userId,version:0,confirm:true})).status,200)
   assert((await actor.request('/api/admin/management/alerts/'+id).then(r=>r.json())).assigneeName)
  }finally{await db.query('DELETE FROM staffly_admin.alerts WHERE id=$1',[id])}
 })
 it('searches all active sessions beyond fifty and applies exact timestamps before pagination in operations and management',async()=>{
  const actor=await account();await actor.ready();const template=(await db.query('SELECT * FROM staffly_admin.sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1',[actor.userId])).rows[0],ids=[] as string[]
  try{
   for(let i=0;i<55;i++){const id=randomUUID();ids.push(id);await db.query("INSERT INTO staffly_admin.sessions(id,user_id,auth_session_id,token_hash,grant_version,user_version,activity_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,now(),now()+interval '1 hour')",[id,actor.userId,template.auth_session_id,randomUUID(),template.grant_version,template.user_version])}
   const read=(suffix:string)=>actor.request('/api/admin/management/security?sessionSearch='+actor.userId+suffix).then(r=>r.json())
   const first=await read(''),last=await read('&sessionPage=3');assert.equal(first.sessionTotal,56);assert.equal(first.sessions.length,20);assert.equal(last.sessions.length,16);assert(!first.sessions.some((item:{id:string})=>last.sessions.some((other:{id:string})=>other.id===item.id)))
   assert.equal((await actor.request('/api/admin/management/security?sessionSearch='+ids[54]).then(r=>r.json())).sessionTotal,1)
   const id=randomUUID();await db.query("INSERT INTO platform_request_errors(id,node_id,method,route,status,name,source,created_at) VALUES($1,$2,'GET','/probe',500,'Error','request','2020-01-01T03:00:00Z')",[id,randomUUID()])
   try{
    const search='&search='+id,exact='from=2020-01-01T03:00:00Z&to=2020-01-01T03:00:00Z'
    assert.equal((await actor.request('/api/admin/operations/support?'+exact+search).then(r=>r.json())).total,1)
    assert.equal((await actor.request('/api/admin/operations/support?from=2020-01-02T00:00:00Z'+search).then(r=>r.json())).total,0)
    for(const route of ['operations/support','operations/jobs','management/alerts','management/backups','management/security']){
     assert.equal((await actor.request('/api/admin/'+route+'?from=2020-02-01T00:00:00Z&to=2020-01-01T00:00:00Z')).status,400)
     const response=await actor.request('/api/admin/'+route+'?'+exact);assert.equal(response.status,200,await response.clone().text())
    }
   }finally{await db.query('DELETE FROM platform_request_errors WHERE id=$1',[id])}
  }finally{await db.query('DELETE FROM staffly_admin.sessions WHERE id=ANY($1::uuid[])',[ids])}
 })
 it('exposes typed global search, truthful environment metadata and component health only after elevated entry',async()=>{
  const actor=await account(),ordinary=await account(false);await actor.ready()
  for(const endpoint of ['meta','attention','search?search=12'])assert.equal((await ordinary.request('/api/admin/'+endpoint)).status,403)
  const result=await actor.request('/api/admin/search?search='+actor.userId).then(r=>r.json());assert.deepEqual(result.groups.map((group:{key:string})=>group.key),['users','organizations','diagnostics','jobs']);assert.match(result.groups[0].items[0].title,/Пользователь №\d+/)
  assert.doesNotMatch(JSON.stringify(result),/password_hash|token_hash|recipient_email|input_hash/)
  const attention=await actor.request('/api/admin/attention');assert.equal(attention.status,200,await attention.clone().text());assert('unassigned' in await attention.json())
  const health=await actor.request('/api/admin/operations/service').then(r=>r.json());assert.deepEqual(health.connections.map((connection:{key:string})=>connection.key),['api','database','mail','files','backups']);assert.equal(health.connections[1].label,'Проверена')
  const saved={APP_ENVIRONMENT:process.env.APP_ENVIRONMENT,APP_DEPLOYED_AT:process.env.APP_DEPLOYED_AT,APP_VERSION:process.env.APP_VERSION}
  try{process.env.APP_ENVIRONMENT='test';process.env.APP_VERSION='1.2.3';process.env.APP_DEPLOYED_AT='2026-11-07T01:23:45Z';const meta=await actor.request('/api/admin/meta').then(r=>r.json());assert.deepEqual(meta,{environment:'test',version:'1.2.3',deployedAt:'2026-11-07T01:23:45.000Z'})}finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
 })
}
