import { documentMime } from '../file-preview/formats.ts'
import { useLocation } from 'react-router-dom'
import { postAuthJson as postJson, requestWithSession, readJson, refreshSession } from './session-transport.ts'
import { useQueryClient } from '@tanstack/react-query'
import { applyLiveHints, setLiveConnected, isLiveConnected } from '../live-query.ts'
import { startLiveStream } from '../live-stream.ts'
/* oxlint-disable react/only-export-components -- The provider and its hook share one context. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo, type ReactNode } from 'react'

export type AuthUser = { id: string; email: string; displayName: string; firstName: string | null; lastName: string | null; middleName: string | null; phone: string | null; bio: string | null; avatarUrl: string | null }
type VerifyEmailBody = { email: string; code: string; password: string; confirmPassword: string; consentData: boolean; consentTerms: boolean }
type AuthResult = { user: AuthUser; accessToken: string }
type ApiOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal }
type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  startupError: string | null
  retryStartup: () => void
  login: (email: string, password: string) => Promise<void>
  verifyEmail: (body: VerifyEmailBody) => Promise<void>
  completeYandex: (body: { currentPassword?: string; consentData?: boolean; consentTerms?: boolean }) => Promise<{ returnTo: string }>
  logout: () => Promise<void>
  updateUser: (user: AuthUser) => void
  apiRequest: <T>(path: string, options?: ApiOptions) => Promise<T>
  uploadImage: <T>(path: string, file: File) => Promise<T>
  uploadFile: <T>(path: string, file: File) => Promise<T>
  downloadFile: (path: string, fileName: string, method?: 'GET' | 'POST', body?: unknown) => Promise<void>
  previewFile: (path: string, method?: 'GET' | 'POST', signal?: AbortSignal) => Promise<Blob>
}

const AuthContext = createContext<AuthContextValue | null>(null)
let bootstrapRequest: Promise<AuthResult | null> | null = null

export async function authPost<T>(path: string, body: unknown): Promise<T> {
  return readJson<T>(await postJson(path, body))
}

export async function authGet<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(`/api/auth/${path}`, { credentials: 'same-origin', cache: 'no-store' }))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const route = useLocation()
  const liveOrganizationId = /^\/app\/organizations\/([0-9a-f-]{36})(?:\/|$)/.exec(route.pathname)?.[1]
  const liveEnabled = route.pathname === '/app' || route.pathname.startsWith('/app/')
  const queryClient = useQueryClient()
  const userIdRef = useRef<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const profileRevision = useRef(0)
  const currentUser = useRef<AuthUser | null>(null)
  const retryStartup = useCallback(() => { setStartupError(null); setLoading(true); setStartupAttempt(n => n + 1) }, [])
  const tokenRef = useRef<string | null>(null)
  const authVersion = useRef(0)
  const refreshRef = useRef<Promise<AuthResult | null> | null>(null)

  const accept = useCallback((result: AuthResult) => {
    if (userIdRef.current !== result.user.id) queryClient.clear()
    userIdRef.current = result.user.id
    authVersion.current += 1
    tokenRef.current = result.accessToken
    setUser(result.user)
    currentUser.current = result.user
    setLoading(false)
    setStartupError(null)
  }, [queryClient])

  const clear = useCallback(() => {
    authVersion.current += 1
    tokenRef.current = null
    userIdRef.current = null
    queryClient.clear()
    setUser(null)
    currentUser.current = null
    setLoading(false)
    setStartupError(null)
  }, [queryClient])

  const refresh = useCallback(async () => {
    const startedAt = authVersion.current
    const startedProfile = profileRevision.current
    refreshRef.current ??= refreshSession<AuthResult>()
      .finally(() => { refreshRef.current = null; bootstrapRequest = null })
    const result = await refreshRef.current
    if (authVersion.current !== startedAt) return tokenRef.current && userIdRef.current === result?.user.id ? result : null
    if (result) accept(startedProfile !== profileRevision.current && currentUser.current?.id === result.user.id ? { ...result, user: currentUser.current } : result)
    else clear()
    return result
  }, [accept, clear])

  useEffect(() => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined, attempts = 0
    const startedAt = authVersion.current
    const bootstrap = () => {
      if (!active || authVersion.current !== startedAt) return
      bootstrapRequest ??= refreshSession<AuthResult>()
        .finally(() => { bootstrapRequest = null })
      void bootstrapRequest.then((result) => {
        if (!active || authVersion.current !== startedAt) return
        if (result) accept(result)
        else clear()
      }).catch((error: Error & { retryAfterMs?: number }) => {
        if (active && authVersion.current === startedAt) {
          setStartupError('Не удалось подключиться к сервису. Соединение восстановится автоматически.')
          retry = setTimeout(bootstrap, Math.max(error.retryAfterMs ?? 0, Math.min(5000, 1000 * 2 ** attempts++)) + Math.random() * 300)
        }
      })
    }
    bootstrap()
    return () => { active = false; clearTimeout(retry) }
  }, [accept, clear, startupAttempt])

  async function login(email: string, password: string) { accept(await authPost<AuthResult>('login', { email, password })) }

  const verifyEmail = useCallback(async (body: VerifyEmailBody) => {
    accept(await authPost<AuthResult>('verify-email', body))
  }, [accept])

  const completeYandex = useCallback(async (body: { currentPassword?: string; consentData?: boolean; consentTerms?: boolean }) => {
    const result = await authPost<AuthResult & { returnTo: string }>('yandex/complete', body)
    accept(result)
    return { returnTo: result.returnTo }
  }, [accept])

  async function logout() {
    try { await postJson('logout', {}) } finally { clear() }
  }

  const apiRequest = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
    const response = await requestWithSession(execute, () => tokenRef.current, refresh)
    return readJson<T>(response)
  }, [refresh])

  const uploadImage = useCallback(async <T,>(path: string, file: File): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    })
    const response = await requestWithSession(execute, () => tokenRef.current, refresh)
    return readJson<T>(response)
  }, [refresh])

  const uploadFile = useCallback(async <T,>(path: string, file: File): Promise<T> => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': documentMime(file.name) || file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file })
    const response = await requestWithSession(execute, () => tokenRef.current, refresh)
    return readJson<T>(response)
  }, [refresh])

  const downloadFile = useCallback(async (path: string, fileName: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    let response = await requestWithSession(execute, () => tokenRef.current, refresh)
    if (response.status === 202) {
      const result = await readJson<{ job: { statusUrl: string } }>(response)
      const statusPath = result.job.statusUrl
      if (!/^\/organizations\/[0-9a-f-]{36}\/statistics\/reports\/exports\/[0-9a-f-]{36}$/.test(statusPath)) throw new Error('Некорректный адрес отчёта.')
      const deadline = Date.now() + 5 * 60000
      let ready = false
      while (Date.now() < deadline) {
        const job = await apiRequest<{ status: string; message?: string }>(statusPath)
        if (job.status === 'FAILED') throw new Error(job.message || 'Не удалось подготовить отчёт.')
        if (job.status === 'READY') { ready = true; break }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      if (!ready) throw new Error('Подготовка отчёта заняла слишком много времени. Попробуйте позже.')
      response = await requestWithSession(token => fetch(`/api${statusPath}/content`, { credentials: 'same-origin', cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} }), () => tokenRef.current, refresh)
    }
    if (!response.ok) { await readJson(response); return }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url)
  }, [refresh, apiRequest])

  const previewFile = useCallback(async (path: string, method: 'GET' | 'POST' = 'GET', signal?: AbortSignal) => {
    const execute = (token: string | null) => fetch(`/api${path}`, { method, signal, credentials: 'same-origin', cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const response = await requestWithSession(execute, () => tokenRef.current, refresh)
    if (!response.ok) { await readJson(response); throw new Error('Не удалось открыть файл.') }
    return response.blob()
  }, [refresh])

  const presenceUserId = user?.id
  useEffect(() => {
    if (!presenceUserId || !liveEnabled) return
    return startLiveStream({
      open: signal => requestWithSession(token => fetch(`/api/live${liveOrganizationId ? `?organizationId=${liveOrganizationId}` : ''}`, {
        signal, credentials: 'same-origin', cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {},
      }), () => tokenRef.current, refresh),
      onReady: () => {
        setLiveConnected(true)
        void queryClient.invalidateQueries({ refetchType: 'active' })
      },
      onChange: hints => {
        void applyLiveHints(queryClient, hints)
        if (hints.some(hint => hint.topic === 'profile' && !hint.organizationId)) {
          const version = authVersion.current
          const revision = profileRevision.current
          void apiRequest<{ user: AuthUser }>('/profile').then(result => {
            if (version === authVersion.current && revision === profileRevision.current && userIdRef.current === result.user.id) { currentUser.current = result.user; setUser(result.user) }
          }).catch(() => undefined)
        }
      },
      onOffline: () => { if (setLiveConnected(false)) void queryClient.invalidateQueries({ refetchType: 'none' }) },
    })
  }, [presenceUserId, liveOrganizationId, queryClient, refresh, liveEnabled, apiRequest])
  useEffect(() => {
    if (!presenceUserId) return
    const heartbeat = () => { if (document.visibilityState === 'visible' && !isLiveConnected()) void apiRequest('/profile/presence', { method: 'POST', body: { visible: true } }).catch(() => undefined) }
    heartbeat()
    const timer = window.setInterval(heartbeat, 30_000)
    document.addEventListener('visibilitychange', heartbeat)
    // A hidden/closed tab expires by TTL. It cannot mark another visible tab of this session offline.
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', heartbeat) }
  }, [presenceUserId, apiRequest])

  const updateUser = useCallback((nextUser: AuthUser) => {
    if (userIdRef.current !== nextUser.id) return
    profileRevision.current += 1
    currentUser.current = nextUser
    setUser(nextUser)
    void queryClient.invalidateQueries({ predicate: query => ['private-media', 'organization-members', 'member-profile', 'location-directory'].includes(String(query.queryKey[0])) })
  }, [queryClient])

  return <AuthContext.Provider value={{ user, loading, startupError, retryStartup, login, verifyEmail, completeYandex, logout, updateUser, apiRequest, uploadImage, uploadFile, downloadFile, previewFile }}>{children}</AuthContext.Provider>
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
    downloadFile: (path: string, name: string, method?: 'GET' | 'POST', body?: unknown) => context.downloadFile(scopePath(path), name, method, body),
    previewFile: (path: string, method?: 'GET' | 'POST', signal?: AbortSignal) => context.previewFile(scopePath(path), method, signal),
  }
  }, [context, locationId, organizationId])
}

export function useMediaSession() { return useContext(AuthContext) }
