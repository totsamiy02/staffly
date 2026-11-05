export function readTabValue(key: string): string | null { try { return sessionStorage.getItem(key) } catch { return null } }
export function writeTabValue(key: string, value: string): boolean { try { sessionStorage.setItem(key, value); return true } catch { return false } }
export function removeTabValue(key: string) { try { sessionStorage.removeItem(key) } catch { /* The browser may deny storage access. */ } }
export function tabKeys(): string[] { try { return Object.keys(sessionStorage) } catch { return [] } }
