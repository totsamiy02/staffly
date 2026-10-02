import { useLocation } from 'react-router-dom'
import { postAuthJson as postJson } from './session-transport.ts'
import { useQueryClient } from '@tanstack/react-query'
/* oxlint-disable react/only-export-components -- The provider and its hook share one context. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo, type ReactNode } from 'react'

export type AuthUser = { id: string; email: string; displayName: string; firstName: string | null; lastName: string | null; middleName: string | null; phone: string | null; bio: string | null; avatarUrl: string | null }
type AuthResult = { user: AuthUser; accessToken: string }
type ApiOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown }
type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  verifyEmail: (email: string, code: string) => Promise<void>
  logout: () => Promise<void>
  updateUser: (user: AuthUser) => void
  apiRequest: <T>(path: string, options?: ApiOptions) => Promise<T>
  uploadImage: <T>(path: string, file: File) => Promise<T>
  uploadFile: <T>(path: string, file: File) => Promise<T>
  downloadFile: (path: string, fileName: string, method?: 'GET' | 'POST') => Promise<void>
  previewFile: (path: string, method?: 'GET' | 'POST') => Promise<Blob>
}

const AuthContext = createContext<AuthContextValue | null>(null)
let bootstrapRequest: Promise<AuthResult | null> | null = null

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let parsed: unknown = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as T & { message?: string; code?: string }
  if (!response.ok) {
    const fallback = response.status === 404 ? 'Запрошенные данные не найдены.' : response.status >= 500 ? 'Сервис временно недоступен. Попробуйте позже.' : 'Не удалось выполнить запрос.'
    const error = new Error(data.message || fallback) as Error & { code?: string; status?: number }
    error.code = data.code
    error.status = response.status
    throw error
  }
  return data
}


export async function authPost<T>(path: string, body: unknown): Promise<T> {
  return readJson<T>(await postJson(path, body))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const userIdRef = useRef<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const tokenRef = useRef<string | null>(null)
  const authVersion = useRef(0)
  const refreshRef = useRef<Promise<AuthResult | null> | null>(null)

  const accept = useCallback((result: AuthResult) => {
    if (userIdRef.current !== result.user.id) queryClient.clear()
    userIdRef.current = result.user.id
    authVersion.current += 1
    tokenRef.current = result.accessToken
    setUser(result.user)
    setLoading(false)
  }, [queryClient])

  const clear = useCallback(() => {
    authVersion.current += 1
    tokenRef.current = null
    userIdRef.current = null
    queryClient.clear()
    setUser(null)
    setLoading(false)
  }, [queryClient])

  const refresh = useCallback(async () => {
    const startedAt = authVersion.current
    refreshRef.current ??= postJson('refresh', {}).then(async (response) => response.ok ? await response.json() as AuthResult : null)
      .catch(() => null)
      .finally(() => { refreshRef.current = null; bootstrapRequest = null })
    const result = await refreshRef.current
    if (authVersion.current !== startedAt) return tokenRef.current && userIdRef.current === result?.user.id ? result : null
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

  const uploadImage = useCallback(async <T,>(path: string, file: File): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    })
    let response = await execute(tokenRef.current)
    if (response.status === 401) {
      const refreshed = await refresh()
      if (refreshed) response = await execute(refreshed.accessToken)
    }
    return readJson<T>(response)
  }, [refresh])

  const uploadFile = useCallback(async <T,>(path: string, file: File): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type || ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', csv: 'text/csv', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[file.name.split('.').at(-1)?.toLowerCase() ?? ''] || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file })
    let response = await execute(tokenRef.current)
    if (response.status === 401) { const refreshed = await refresh(); if (refreshed) response = await execute(refreshed.accessToken) }
    return readJson<T>(response)
  }, [refresh])

  const downloadFile = useCallback(async (path: string, fileName: string, method: 'GET' | 'POST' = 'GET') => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method, credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {} })
    let response = await execute(tokenRef.current)
    if (response.status === 401) { const refreshed = await refresh(); if (refreshed) response = await execute(refreshed.accessToken) }
    if (!response.ok) { await readJson(response); return }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url)
  }, [refresh])

  const previewFile = useCallback(async (path: string, method: 'GET' | 'POST' = 'GET') => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method, credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {} })
    let response = await execute(tokenRef.current)
    if (response.status === 401) { const refreshed = await refresh(); if (refreshed) response = await execute(refreshed.accessToken) }
    if (!response.ok) { await readJson(response); throw new Error('Не удалось открыть файл.') }
    return response.blob()
  }, [refresh])

  const presenceUserId = user?.id
  useEffect(() => {
    if (!presenceUserId) return
    const heartbeat = () => { if (document.visibilityState === 'visible') void apiRequest('/profile/presence', { method: 'POST', body: { visible: true } }).catch(() => undefined) }
    heartbeat()
    const timer = window.setInterval(heartbeat, 30_000)
    document.addEventListener('visibilitychange', heartbeat)
    // A hidden/closed tab expires by TTL. It cannot mark another visible tab of this session offline.
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', heartbeat) }
  }, [presenceUserId, apiRequest])

  const updateUser = useCallback((nextUser: AuthUser) => setUser(nextUser), [])

  return <AuthContext.Provider value={{ user, loading, login, verifyEmail, logout, updateUser, apiRequest, uploadImage, uploadFile, downloadFile, previewFile }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider is missing')
  const route = useLocation()
  const organizationId = /^\/app\/organizations\/([^/]+)/.exec(route.pathname)?.[1]
  const locationId = new URLSearchParams(route.search).get('location') ?? (organizationId ? window.sessionStorage.getItem(`staffly:location:${context.user?.id}:${organizationId}`) : null) ?? undefined
  return useMemo(() => {
  const scopePath = (path: string) => {
    if (!locationId || !organizationId || !path.startsWith(`/organizations/${organizationId}`)) return path
    const url = new URL(path, window.location.origin)
    if (!url.searchParams.has('locationId')) url.searchParams.set('locationId', locationId)
    return url.pathname + url.search
  }
  return { ...context, locationId, organizationId,
    apiRequest: <T,>(path: string, options?: ApiOptions) => context.apiRequest<T>(scopePath(path), options),
    uploadFile: <T,>(path: string, file: File) => context.uploadFile<T>(scopePath(path), file),
    uploadImage: <T,>(path: string, file: File) => context.uploadImage<T>(scopePath(path), file),
    downloadFile: (path: string, name: string, method?: 'GET' | 'POST') => context.downloadFile(scopePath(path), name, method),
    previewFile: (path: string, method?: 'GET' | 'POST') => context.previewFile(scopePath(path), method),
  }
  }, [context, locationId, organizationId])
}
