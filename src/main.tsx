import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { AuthProvider } from './app/auth/auth-context.tsx'
import RootErrorBoundary from './pages/error/root-error-boundary.tsx'
import './index.scss'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <RootErrorBoundary><AuthProvider><App /></AuthProvider></RootErrorBoundary>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
)
