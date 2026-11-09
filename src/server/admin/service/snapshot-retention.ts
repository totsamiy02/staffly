import { readdir,lstat,readFile,rm } from 'node:fs/promises'
import path from 'node:path'
import { privateDirectory } from './backup-components.ts'
export async function pruneFileSnapshots(directory:string,now=new Date()){
 const root=await privateDirectory(directory);let deleted=0
 for(const name of await readdir(root)){
  if(!/^set-[a-f0-9-]{36}$/.test(name))continue
  const set=path.join(root,name),stat=await lstat(set);if(!stat.isDirectory()||stat.isSymbolicLink())continue
  const file=path.join(set,'manifest.json'),manifestStat=await lstat(file).catch(()=>null)
  if(!manifestStat?.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>64*1024*1024)continue
  const manifest=JSON.parse(await readFile(file,'utf8'))
  if(manifest.format!=='staffly-files-backup-v1'||'set-'+manifest.backupId!==name||Date.parse(manifest.expiresAt)!==Date.parse(manifest.snapshotAt)+30*86400000||Date.parse(manifest.expiresAt)>+now)continue
  await rm(set,{recursive:true});deleted++
 }
 return{deleted}
}
