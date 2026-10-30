import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Header from './component/header/header.tsx'
import Footer from './component/footer/footer.tsx'
import CookieConsent from './component/cookie-consent/cookie-consent.tsx'
import ProtectedRoute from './pages/app/shell/protected-route.tsx'
import StatusPage from './pages/error/status-page.tsx'
import ThemeToggle from './component/ui/theme-toggle/theme-toggle.tsx'

const PrivacyPolicy = lazy(() => import('./pages/legal/privacy-policy.tsx'))
const PersonalDataConsent = lazy(() => import('./pages/legal/personal-data-consent.tsx'))
const Terms = lazy(() => import('./pages/legal/terms.tsx'))
const Offer = lazy(() => import('./pages/legal/offer.tsx'))
const AuthPage = lazy(() => import('./pages/auth/auth.tsx'))
const YandexCompletePage = lazy(() => import('./pages/auth/yandex-complete.tsx'))
const VerifyEmailPage = lazy(() => import('./pages/auth/verify-email.tsx'))
const ResetPasswordPage = lazy(() => import('./pages/auth/reset-password.tsx'))
const ForgotPasswordPage = lazy(() => import('./pages/auth/forgot-password.tsx'))

const OrganizationsPage = lazy(() => import('./pages/app/organizations/organizations-page.tsx'))
const CreateOrganizationPage = lazy(() => import('./pages/app/organizations/create-organization-page.tsx'))
const OrganizationLayout = lazy(() => import('./pages/app/shell/organization-layout.tsx'))
const UserSettingsPage = lazy(() => import('./pages/app/settings/account/user-settings-page.tsx'))

const GuidePage = lazy(() => import('./pages/guide/guide-page.tsx'))

const HomePage = lazy(() => import('./pages/home/home-page.tsx'))

function App() {
  const pathname = useLocation().pathname
  const isAuthPage = ['/auth', '/auth/yandex', '/verify-email', '/forgot-password', '/reset-password'].includes(pathname)
  const isAppPage = pathname === '/app' || pathname.startsWith('/app/')
  const isGuidePage = pathname === '/guide' || pathname.startsWith('/guide/')
  const hidePublicFrame = isAuthPage || isAppPage || isGuidePage

  return (
    <>
      {!hidePublicFrame && <Header />}
      {isAuthPage && <div className="auth-theme-control"><ThemeToggle /></div>}

      <Suspense fallback={<main className="route-loading" role="status">Загрузка…</main>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/guide" element={<Suspense fallback={<main className="app-loading" aria-label="Загрузка справочника"><span /></main>}><GuidePage /></Suspense>} />
        <Route path="/guide/category/:categoryId" element={<Suspense fallback={<main className="app-loading" aria-label="Загрузка справочника"><span /></main>}><GuidePage /></Suspense>} />
        <Route path="/guide/:slug" element={<Suspense fallback={<main className="app-loading" aria-label="Загрузка справочника"><span /></main>}><GuidePage /></Suspense>} />
        <Route path="/guide/*" element={<Suspense fallback={<main className="app-loading" aria-label="Загрузка справочника"><span /></main>}><GuidePage /></Suspense>} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/auth/yandex" element={<YandexCompletePage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/workspace" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<ProtectedRoute><OrganizationsPage /></ProtectedRoute>} />
        <Route path="/app/organizations/new" element={<ProtectedRoute><CreateOrganizationPage /></ProtectedRoute>} />
        <Route path="/app/notifications" element={<Navigate to="/app" replace />} />
        <Route path="/app/settings" element={<ProtectedRoute><UserSettingsPage /></ProtectedRoute>} />
        <Route path="/app/organizations/:organizationId/*" element={<ProtectedRoute><OrganizationLayout /></ProtectedRoute>} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="/personal-data-consent" element={<PersonalDataConsent />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="/cookie-policy" element={<Navigate to="/privacy-policy#cookies" replace />} />
        <Route path="*" element={<StatusPage status={404} />} />
      </Routes>
      </Suspense>

      {!hidePublicFrame && <Footer />}
      {!hidePublicFrame && <CookieConsent />}
    </>
  )
}

export default App
