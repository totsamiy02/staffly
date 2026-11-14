import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from '../../src/app/auth/auth-context.tsx'
import ToastProvider from '../../src/component/ui/toast/toast.tsx'
import { useToast } from '../../src/component/ui/toast/toast-context.ts'
import RequestErrorMessage, { RequestErrorState } from '../../src/component/ui/request-error-message.tsx'
import OperationStatus from '../../src/component/ui/operation-status.tsx'
import RootErrorBoundary from '../../src/pages/error/root-error-boundary.tsx'
import StatusPage from '../../src/pages/error/status-page.tsx'
import ModuleErrorBoundary from '../../src/pages/app/shell/module-error-boundary.tsx'
import { Loading, ReadError } from '../../src/features/admin/admin-feedback.tsx'
import '../../src/index.scss'
import '../../src/pages/app/app.scss'
import '../../src/pages/auth/auth.scss'
import '../../src/features/admin/admin.scss'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const errorId = '21822b7b-6686-435b-bb84-771defc187aa'
const message = 'Сервис временно недоступен. Попробуйте немного позже.'
const error = Object.assign(new Error(message), { errorId })

export function Failure(): never {
  throw new Error('Synthetic error layout acceptance')
}

function ToastExample() {
  const toast = useToast()
  const { loading } = useAuth()
  return <main style={{ maxWidth: 680, margin: '0 auto', padding: '280px 16px 16px' }}>
    <h1>Уведомления</h1>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
      <button className="app-secondary" disabled={loading} onClick={() => toast(message + ' Код для поддержки: ' + errorId, 'error')}>Показать ошибку</button>
      <button className="app-secondary" onClick={() => toast('Не удалось получить подтверждение от сервера. Проверьте соединение и результат операции перед повторной отправкой. Код для поддержки: ' + errorId, 'error')}>Длинная ошибка</button>
      <button className="app-secondary" onClick={() => toast('Изменения сохранены.', 'success')}>Успешное действие</button>
      <button className="app-secondary" onClick={() => toast('Данные обновлены.')}>Информация</button>
    </div>
  </main>
}

function InlineExamples() {
  const [retried, setRetried] = useState(false)
  const retry = () => setRetried(true)
  return <main style={{ maxWidth: 680, padding: 16, margin: '24px auto', display: 'grid', gap: 24 }}>
    <h1>Ошибки в разделах и формах</h1>
    <RequestErrorState error={error} onRetry={retry} />
    <div className="form-inline-error" role="alert"><RequestErrorMessage error={error} /></div>
    <div className="auth" style={{ minHeight: 0, padding: 16, borderRadius: 12 }}>
      <p className="auth__error" role="alert"><RequestErrorMessage error={error} /></p>
    </div>
    <OperationStatus state={{ phase: 'failed', message, errorId }} onRetry={retry} />
    <output aria-live="polite">{retried ? 'Повтор запрошен' : ''}</output>
  </main>
}

function AdminExamples() {
  return <main className="admin-root" style={{ maxWidth: 680, padding: 16, margin: '24px auto' }}>
    <h1 style={{ marginBottom: 24 }}>Ошибка загрузки</h1>
    <Loading error={error} retry={() => {}} />
    <ReadError error={error} retry={() => {}} />
  </main>
}

function Example() {
  switch (params.get('surface')) {
    case 'toast': return <QueryClientProvider client={new QueryClient()}>
      <AuthProvider><ToastProvider><ToastExample /></ToastProvider></AuthProvider>
    </QueryClientProvider>
    case '404': return <StatusPage />
    case 'inline': return <InlineExamples />
    case 'admin': return <AdminExamples />
    case 'module': return <main style={{ maxWidth: 680, padding: 16, margin: '24px auto' }}>
      <ModuleErrorBoundary organizationPath="/app"><Failure /></ModuleErrorBoundary>
    </main>
    default: return <RootErrorBoundary><Failure /></RootErrorBoundary>
  }
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><Example /></BrowserRouter>)
