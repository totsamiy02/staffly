import './header.scss'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { Link } from 'react-router-dom'
import { useAuth } from '../../app/auth/auth-context.tsx'

function Header() {
  const { user, loading, logout } = useAuth()
  return (
    <header className="header" id="top">
      <div className="container header__container">
        <a className="header__logo" href="/" aria-label="Staffly — главная">
          <img src={logo} alt="Staffly" />
        </a>

        {loading ? null : user ? (
          <div className="header__profile">
            <Link className="header__profile-link" to="/workspace" aria-label={`Профиль ${user.displayName}`}>
              <span className="header__avatar" aria-hidden="true" />
              <span>{user.displayName}</span>
            </Link>
            <button type="button" className="header__logout" onClick={() => { void logout() }}>Выйти</button>
          </div>
        ) : (
          <div className="header__buttons">
            <Link className="button button--white" to="/auth?mode=login">Вход</Link>
            <Link className="button button--black" to="/auth?mode=register">Регистрация</Link>
          </div>
        )}
      </div>
    </header>
  )
}

export default Header
