import { BlackButton, WhiteButton } from '../ui/btn/button'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'
import './hero.scss'

function Hero() {
  const navigate = useNavigate()
  const { user } = useAuth()
  return (
    <section className="hero" id="about">
      <div className="container hero__container">
        <h1>Staffly</h1>
        <p>Удобный инструмент для управления персоналом малого бизнеса</p>

        <div className="hero__actions">
          <BlackButton onClick={() => navigate(user ? '/app/organizations/new' : '/auth?mode=register&returnTo=%2Fapp%2Forganizations%2Fnew')}>Создать организацию</BlackButton>
          <WhiteButton onClick={() => navigate(user ? '/app#join-organization' : '/auth?mode=login&returnTo=%2Fapp%23join-organization')}>Войти в организацию</WhiteButton>
        </div>
      </div>
    </section>
  )
}

export default Hero
