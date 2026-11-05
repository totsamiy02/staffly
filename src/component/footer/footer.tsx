import logo from '../../assets/images/logo/staffly-logo.svg'
import './footer.scss'

const footerLinks = [
  {
    title: 'Продукт',
    links: [
      { label: 'О сервисе', href: '/#about' },
      { label: 'Возможности', href: '/#benefits' },
      { label: 'Справочник', href: '/guide' },
      { label: 'Тарифы', href: '/#pricing' },
      { label: 'Начало страницы', href: '/#top' },
    ],
  },
  {
    title: 'Документы',
    links: [
      { label: 'Политика обработки персональных данных', href: '/privacy-policy' },
      { label: 'Согласие на обработку персональных данных', href: '/personal-data-consent' },
      { label: 'Пользовательское соглашение', href: '/terms' },
      { label: 'Публичная оферта', href: '/offer' },
    ],
  },
  {
    title: 'Информация',
    links: [
      { label: 'Политика cookie', href: '/privacy-policy#cookies' },
      { label: 'Оплата и отмена подписки', href: '/offer#payment' },
      { label: 'Реквизиты', href: '/offer#details' },
      { label: 'Контакты', href: '/privacy-policy#contacts' },
    ],
  },
]

function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__container">
        <div className="footer__brand">
          <a href="/" aria-label="Staffly — главная">
            <img src={logo} alt="Staffly" />
          </a>
          <p>Удобный инструмент для управления персоналом малого бизнеса</p>

        </div>

        <nav className="footer__navigation" aria-label="Навигация в подвале">
          {footerLinks.map((column) => (
            <div className="footer__column" key={column.title}>
              <h2>{column.title}</h2>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="container footer__bottom">
        <p>© {new Date().getFullYear()} Staffly. Все права защищены.</p>
        <p>Реквизиты владельца сервиса будут добавлены перед публикацией.</p>
      </div>
    </footer>
  )
}

export default Footer
