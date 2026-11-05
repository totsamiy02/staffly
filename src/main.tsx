import ToastProvider from './component/ui/toast/toast.tsx'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { AuthProvider } from './app/auth/auth-context.tsx'
import RootErrorBoundary from './pages/error/root-error-boundary.tsx'
import './index.scss'
import ThemeController from './app/theme/theme-controller.tsx'
import { retryQuery, queryRetryDelay } from './app/query-retry.ts'
import FormSafetyProvider from './app/forms/form-safety-provider.tsx'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: retryQuery, retryDelay: queryRetryDelay, refetchOnWindowFocus: false }, mutations: { retry: false } } })
const router = createBrowserRouter([{ path: '*', element: <QueryClientProvider client={queryClient}><RootErrorBoundary><AuthProvider><ToastProvider><FormSafetyProvider><App /></FormSafetyProvider></ToastProvider></AuthProvider></RootErrorBoundary></QueryClientProvider> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeController />
    <RouterProvider router={router} />
  </StrictMode>,
)
