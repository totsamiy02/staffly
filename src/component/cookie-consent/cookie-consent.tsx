import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BlackButton, WhiteButton } from '../ui/btn/button'
import Modal from '../ui/modal/modal'

const COOKIE_CONSENT_KEY = 'staffly-cookie-consent'

function hasSavedChoice() {
  try {
    return localStorage.getItem(COOKIE_CONSENT_KEY) !== null
  } catch {
    return false
  }
}

function CookieConsent() {
  const { pathname } = useLocation()
  const [isOpen, setIsOpen] = useState(() => !hasSavedChoice())
  const readingPolicy = ['/privacy-policy', '/personal-data-consent', '/terms', '/offer'].includes(pathname)

  function saveChoice(value: 'necessary' | 'all') {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, value)
    } finally {
      setIsOpen(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen && !readingPolicy}
      title="Мы используем cookie"
      actions={
        <>
          <WhiteButton onClick={() => saveChoice('necessary')}>
            Только необходимые
          </WhiteButton>
          <BlackButton onClick={() => saveChoice('all')}>Принять все</BlackButton>
        </>
      }
    >
      <p>
        Необходимые cookie обеспечивают работу сайта. Дополнительные cookie можно
        использовать для аналитики только после вашего согласия. Подробнее — в{' '}
        <a href="/privacy-policy#cookies">политике cookie</a>.
      </p>
    </Modal>
  )
}

export default CookieConsent
