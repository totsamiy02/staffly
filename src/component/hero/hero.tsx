import { BlackButton, WhiteButton } from '../ui/btn/button'
import { useNavigate } from 'react-router-dom'
import './hero.scss'

function Hero() {
  const navigate = useNavigate()
  return (
    <section className="hero" id="about">
      <div className="container hero__container">
        <h1>Staffly</h1>
        <p>Удобный инструмент для управления персоналом малого бизнеса</p>

        <div className="hero__actions">
          <BlackButton onClick={() => navigate('/auth?mode=register')}>Создать организацию</BlackButton>
          <WhiteButton onClick={() => navigate('/auth?mode=login')}>Войти в организацию</WhiteButton>
        </div>
      </div>
    </section>
  )
}

export default Hero
