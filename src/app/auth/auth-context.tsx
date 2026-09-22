/* oxlint-disable react/only-export-components -- The provider and its hook share one context. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export type AuthUser = { id: string; email: string; displayName: string }
type AuthResult = { user: AuthUser; accessToken: string }
type ApiOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }
type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  verifyEmail: (email: string, code: string) => Promise<void>
  logout: () => Promise<void>
  apiRequest: <T>(path: string, options?: ApiOptions) => Promise<T>
}

const AuthContext = createContext<AuthContextValue | null>(null)
let bootstrapRequest: Promise<AuthResult | null> | null = null

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const data = await response.json() as T & { message?: string; code?: string }
  if (!response.ok) {
    const error = new Error(data.message || 'Не удалось выполнить запрос.') as Error & { code?: string; status?: number }
    error.code = data.code
    error.status = response.status
    throw error
  }
  return data
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
}

export async function authPost<T>(path: string, body: unknown): Promise<T> {
  return readJson<T>(await postJson(path, body))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const tokenRef = useRef<string | null>(null)
  const authVersion = useRef(0)
  const refreshRef = useRef<Promise<AuthResult | null> | null>(null)

  const accept = useCallback((result: AuthResult) => {
    authVersion.current += 1
    tokenRef.current = result.accessToken
    setUser(result.user)
    setLoading(false)
  }, [])

  const clear = useCallback(() => {
    authVersion.current += 1
    tokenRef.current = null
    setUser(null)
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    refreshRef.current ??= postJson('refresh', {}).then(async (response) => response.ok ? await response.json() as AuthResult : null)
      .catch(() => null)
      .finally(() => { refreshRef.current = null; bootstrapRequest = null })
    const result = await refreshRef.current
    if (result) accept(result)
    else clear()
    return result
  }, [accept, clear])

  useEffect(() => {
    let active = true
    const startedAt = authVersion.current
    bootstrapRequest ??= postJson('refresh', {}).then(async (response) => response.ok ? await response.json() as AuthResult : null)
      .catch(() => null)
      .finally(() => { bootstrapRequest = null })
    void bootstrapRequest.then((result) => {
      if (!active || authVersion.current !== startedAt) return
      if (result) accept(result)
      else clear()
    })
    return () => { active = false }
  }, [accept, clear])

  async function login(email: string, password: string) { accept(await authPost<AuthResult>('login', { email, password })) }

  const verifyEmail = useCallback(async (email: string, code: string) => {
    accept(await authPost<AuthResult>('verify-email', { email, code }))
  }, [accept])

  async function logout() {
    try { await postJson('logout', {}) } finally { clear() }
  }

  const apiRequest = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
    let response = await execute(tokenRef.current)
    if (response.status === 401) {
      const refreshed = await refresh()
      if (refreshed) response = await execute(refreshed.accessToken)
    }
    return readJson<T>(response)
  }, [refresh])

  return <AuthContext.Provider value={{ user, loading, login, verifyEmail, logout, apiRequest }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider is missing')
  return context
}
