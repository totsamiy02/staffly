import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import logo from '../../assets/images/logo/staffly-logo.svg'
import './header-frame.scss'

/** Shared shell; public, workspace and guide pages provide their own controls. */
export default function HeaderFrame({ variant = 'app', children, afterContent, id }: { variant?: 'public' | 'app' | 'workspace'; children: ReactNode; afterContent?: ReactNode; id?: string }) {
  const publicHeader = variant === 'public'
  return <header id={id} className={`site-header ${publicHeader ? 'header' : `app-topbar${variant === 'workspace' ? ' app-topbar--workspace' : ''}`}`}>
    <div className={`site-header__inner ${publicHeader ? 'container header__container' : 'app-topbar__inner'}`}>
      <Link to="/" className={`site-header__brand ${publicHeader ? 'header__logo' : 'app-topbar__logo'}`} aria-label="На главную Staffly"><img src={logo} alt="Staffly" /></Link>
      {children}
    </div>
    {afterContent}
  </header>
}
