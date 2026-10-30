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
        <div className="hero__copy">
        <h1>Команда работает<br />слаженно.</h1>
        <p>Расписание, сотрудники и документы — в одном месте.</p>

        <div className="hero__actions">
          <BlackButton onClick={() => navigate(user ? '/app' : '/auth?mode=login')}>{user ? 'Мои организации' : 'Войти'}</BlackButton>
          <WhiteButton onClick={() => navigate(user ? '/app/organizations/new' : '/auth?mode=register&returnTo=%2Fapp%2Forganizations%2Fnew')}>Создать организацию</WhiteButton>
        </div>
        </div>
        <div className="hero__preview" aria-hidden="true">
          <div className="hero__preview-calendar"><strong>Расписание команды</strong><div className="hero__preview-days">{['Пн','Вт','Ср','Чт','Пт'].map(day => <span key={day}>{day}</span>)}</div><div className="hero__preview-shifts">{Array.from({ length: 20 }, (_, index) => <i className={index % 3 ? 'is-shift' : ''} key={index} />)}</div><small>Всё по плану</small></div>
          <div className="hero__preview-people"><strong>Сотрудники</strong>{['Анна','Михаил','София'].map((name, index) => <div key={name}><b>{name[0]}</b><span>{name}<i style={{ width: `${65 + index * 12}%` }} /></span></div>)}</div>
          <div className="hero__preview-documents"><span>✓</span><strong>Документы</strong><small>Всё нужное — под рукой</small><i /><i /></div>
        </div>
      </div>
    </section>
  )
}

export default Hero
