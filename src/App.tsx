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
  const isAuthPage = useLocation().pathname === '/auth'

  return (
    <>
      {!isAuthPage && <Header />}

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="/personal-data-consent" element={<PersonalDataConsent />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="/cookie-policy" element={<Navigate to="/privacy-policy#cookies" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {!isAuthPage && <Footer />}
      {!isAuthPage && <CookieConsent />}
    </>
  )
}

export default App
