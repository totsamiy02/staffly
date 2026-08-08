import Header from './component/header/header.tsx'
import Hero from './component/hero/hero.tsx'
import Benefits from './component/benefits/benefits.tsx'
import Pricing from './component/pricing/pricing.tsx'
import Footer from './component/footer/footer.tsx'
import CookieConsent from './component/cookie-consent/cookie-consent.tsx'

function App() {
  return (
    <>
      <Header />

      <main>
        <Hero />
        <Benefits />
        <Pricing />
      </main>

      <Footer />
      <CookieConsent />
    </>
  )
}

export default App
