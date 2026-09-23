import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Header from './component/header/header.tsx'
import Hero from './component/hero/hero.tsx'
import Benefits from './component/benefits/benefits.tsx'
import Pricing from './component/pricing/pricing.tsx'
import Footer from './component/footer/footer.tsx'
import CookieConsent from './component/cookie-consent/cookie-consent.tsx'
import PrivacyPolicy from './pages/legal/privacy-policy.tsx'
import PersonalDataConsent from './pages/legal/personal-data-consent.tsx'
import Terms from './pages/legal/terms.tsx'
import Offer from './pages/legal/offer.tsx'
import AuthPage from './pages/auth/auth.tsx'
import VerifyEmailPage from './pages/auth/verify-email.tsx'
import ResetPasswordPage from './pages/auth/reset-password.tsx'
import ForgotPasswordPage from './pages/auth/forgot-password.tsx'
import ProtectedRoute from './pages/app/protected-route.tsx'
import OrganizationsPage from './pages/app/organizations-page.tsx'
import CreateOrganizationPage from './pages/app/create-organization-page.tsx'
import OrganizationLayout from './pages/app/organization-layout.tsx'
import UserSettingsPage from './pages/app/user-settings-page.tsx'
import StatusPage from './pages/error/status-page.tsx'

function HomePage() {
  return (
    <main>
      <Hero />
      <Benefits />
      <Pricing />
    </main>
  )
}

function App() {
  const pathname = useLocation().pathname
  const isAuthPage = ['/auth', '/verify-email', '/forgot-password', '/reset-password'].includes(pathname)
  const isAppPage = pathname === '/app' || pathname.startsWith('/app/')
  const hidePublicFrame = isAuthPage || isAppPage

  return (
    <>
      {!hidePublicFrame && <Header />}

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/workspace" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<ProtectedRoute><OrganizationsPage /></ProtectedRoute>} />
        <Route path="/app/organizations/new" element={<ProtectedRoute><CreateOrganizationPage /></ProtectedRoute>} />
        <Route path="/app/settings" element={<ProtectedRoute><UserSettingsPage /></ProtectedRoute>} />
        <Route path="/app/organizations/:organizationId/*" element={<ProtectedRoute><OrganizationLayout /></ProtectedRoute>} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="/personal-data-consent" element={<PersonalDataConsent />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="/cookie-policy" element={<Navigate to="/privacy-policy#cookies" replace />} />
        <Route path="*" element={<StatusPage status={404} />} />
      </Routes>

      {!hidePublicFrame && <Footer />}
      {!hidePublicFrame && <CookieConsent />}
    </>
  )
}

export default App
