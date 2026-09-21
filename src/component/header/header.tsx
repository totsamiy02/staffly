import './header.scss'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { Link } from 'react-router-dom'

function Header() {
  return (
    <header className="header" id="top">
      <div className="container header__container">
        <a className="header__logo" href="/" aria-label="Staffly — главная">
          <img src={logo} alt="Staffly" />
        </a>

        <div className="header__buttons">
          <Link className="button button--white" to="/auth?mode=login">Вход</Link>
          <Link className="button button--black" to="/auth?mode=register">Регистрация</Link>
        </div>
      </div>
    </header>
  )
}

export default Header
