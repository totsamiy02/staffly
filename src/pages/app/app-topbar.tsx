import { Link, useNavigate } from 'react-router-dom'
import logo from '../../assets/images/logo/staffly-logo.svg'
import { useAuth } from '../../app/auth/auth-context.tsx'

export default function AppTopbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return <header className="app-topbar">
    <Link to="/app" className="app-topbar__logo"><img src={logo} alt="Staffly" /></Link>
    <div className="app-topbar__account">
      <span className="app-avatar" aria-hidden="true">{user?.displayName.slice(0, 1).toUpperCase()}</span>
      <span className="app-topbar__name">{user?.displayName}</span>
      <button type="button" onClick={() => { void logout().then(() => navigate('/', { replace: true })) }}>Выйти</button>
    </div>
  </header>
}
