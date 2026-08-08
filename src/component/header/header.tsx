import './header.scss'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { BlackButton, WhiteButton } from '../ui/btn/button'

function Header() {
  return (
    <header className="header" id="top">
      <div className="container header__container">
        <a className="header__logo" href="/" aria-label="Staffly — главная">
          <img src={logo} alt="Staffly" />
        </a>

        <div className="header__buttons">
          <WhiteButton>Вход</WhiteButton>
          <BlackButton>Регистрация</BlackButton>
        </div>
      </div>
    </header>
  )
}

export default Header
