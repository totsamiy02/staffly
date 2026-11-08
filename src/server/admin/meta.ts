import { readFileSync } from 'node:fs'
const packageVersion=String(JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version)
export function adminMeta(){
 const configured=process.env.APP_VERSION,version=configured&&/^[\w.+-]{1,100}$/.test(configured)?configured:packageVersion
 const at=process.env.APP_DEPLOYED_AT,deployedAt=at&&Number.isFinite(Date.parse(at))?new Date(at).toISOString():null
 const configuredEnvironment=process.env.APP_ENVIRONMENT,environment=['production','test','development'].includes(configuredEnvironment??'')?configuredEnvironment!:process.env.NODE_ENV==='test'?'test':process.env.NODE_ENV==='production'?'unknown':'development'
 return{environment,version,deployedAt}
}
