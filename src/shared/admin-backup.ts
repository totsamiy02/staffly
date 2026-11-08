export type BackupState = 'AVAILABLE' | 'MISSING' | 'INVALID' | 'EXPIRED'
export const backupLabels: Record<BackupState, string> = { AVAILABLE: 'Доступна', MISSING: 'Файл не найден', INVALID: 'Не прошла проверку', EXPIRED: 'Срок истёк' }
export function effectiveBackupState(state: string, expiresAt: string | null, now = Date.now()): BackupState {
  if (!expiresAt || Date.parse(expiresAt) <= now || state === 'EXPIRED') return 'EXPIRED'
  return state === 'AVAILABLE' || state === 'MISSING' ? state : 'INVALID'
}
