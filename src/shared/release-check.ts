export const requiredReleaseChecks = ['build','types','lint','serverTests','browserTests','personnelTests','containerTests','migrations','secrets'] as const
export function releaseChecksPassed(value: unknown): boolean {
  return !!value && typeof value === 'object' && requiredReleaseChecks.every(key => (value as Record<string,unknown>)[key] === true)
}

export function verifiedReleaseChecks(value:unknown,version:string):boolean {
  if(!releaseChecksPassed(value)||!value||typeof value!=='object')return false
  const ci=(value as {ci?:Record<string,unknown>}).ci
  return !!ci&&ci.headSha===version&&typeof ci.repository==='string'&&/^[\w.-]+\/[\w.-]+$/.test(ci.repository)&&Number.isSafeInteger(ci.runId)&&Number(ci.runId)>0&&Number.isSafeInteger(ci.runAttempt)&&Number(ci.runAttempt)>0&&typeof ci.verifiedAt==='string'&&Number.isFinite(Date.parse(ci.verifiedAt))
}
