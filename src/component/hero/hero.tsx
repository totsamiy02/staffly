import { BlackButton, WhiteButton } from '../ui/btn/button'
import './hero.scss'

function Hero() {
  return (
    <section className="hero" id="about">
      <div className="container hero__container">
        <h1>Staffly</h1>
        <p>Удобный инструмент для управления персоналом малого бизнеса</p>

        <div className="hero__actions">
          <BlackButton>Создать организацию</BlackButton>
          <WhiteButton>Войти в организацию</WhiteButton>
        </div>
      </div>
    </section>
  )
}

export default Hero
