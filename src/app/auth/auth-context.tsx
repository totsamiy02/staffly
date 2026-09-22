/* oxlint-disable react/only-export-components -- The provider and its hook share one context. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

export type AuthUser = { id: string; email: string; displayName: string }
type AuthResult = { user: AuthUser; accessToken: string }
type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  verifyEmail: (email: string, code: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)
let bootstrapRequest: Promise<AuthResult | null> | null = null

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
}

export async function authPost<T>(path: string, body: unknown): Promise<T> {
  const response = await postJson(path, body)
  const data = await response.json() as T & { message?: string }
  if (!response.ok) throw new Error(data.message || 'Не удалось выполнить запрос.')
  return data
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [, setAccessToken] = useState<string | null>(null)
  const authVersion = useRef(0)

  const accept = useCallback((result: AuthResult) => {
    authVersion.current += 1
    setUser(result.user)
    setAccessToken(result.accessToken)
    setLoading(false)
  }, [])

  useEffect(() => {
    let active = true
    const startedAt = authVersion.current
    bootstrapRequest ??= postJson('refresh', {}).then(async (response) => response.ok ? await response.json() as AuthResult : null)
      .catch(() => null)
      .finally(() => { bootstrapRequest = null })
    void bootstrapRequest.then((result) => {
      if (!active) return
      if (result && authVersion.current === startedAt) accept(result)
      setLoading(false)
    })
    return () => { active = false }
  }, [accept])

  async function login(email: string, password: string) {
    accept(await authPost<AuthResult>('login', { email, password }))
  }

  const verifyEmail = useCallback(async (email: string, code: string) => {
    accept(await authPost<AuthResult>('verify-email', { email, code }))
  }, [accept])

  async function logout() {
    try { await postJson('logout', {}) } finally { authVersion.current += 1; setUser(null); setAccessToken(null) }
  }

  return <AuthContext.Provider value={{ user, loading, login, verifyEmail, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider is missing')
  return context
}
