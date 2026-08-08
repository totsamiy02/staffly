import logo from '../../assets/images/logo/staffly-logo.svg'
import './footer.scss'

const footerLinks = [
  {
    title: 'Продукт',
    links: [
      { label: 'О сервисе', href: '#about' },
      { label: 'Возможности', href: '#benefits' },
      { label: 'Тарифы', href: '#pricing' },
      { label: 'Начало страницы', href: '#top' },
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
      { label: 'Политика cookie', href: '/cookie-policy' },
      { label: 'Оплата и отмена подписки', href: '/payment-and-refunds' },
      { label: 'Реквизиты', href: '/company-details' },
      { label: 'Контакты', href: '/contacts' },
    ],
  },
]

function VkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.4 4.5C2 4.5 1.7 5.2 1.7 6c0 7.1 3.7 13.5 10.5 13.5h.7v-4.1c2.7.3 4.7 2.3 5.5 4.1H22c-1-2.8-3.5-4.9-5-5.7 1.5-.9 3.7-3.4 4.2-6.3h-3.3c-.7 2.2-2.5 4.7-5 4.9V7.5c0-1.5-.4-3-2.8-3H7.4v.4c1.3.2 1.8.9 1.8 2.8v7.4C6.6 14.4 4.6 10.4 4.4 6c-.1-.9-.4-1.5-1-1.5Z" />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21.6 3.2 18.4 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L5.9 13.8 1 12.3c-1.1-.3-1.1-1.1.2-1.6L20.3 3.3c.9-.3 1.7.2 1.3-.1Z" />
    </svg>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__container">
        <div className="footer__brand">
          <a href="#top" aria-label="Staffly — начало страницы">
            <img src={logo} alt="Staffly" />
          </a>
          <p>Удобный инструмент для управления персоналом малого бизнеса</p>

          <div className="footer__socials">
            <a href="#!" aria-label="Staffly во ВКонтакте">
              <VkIcon />
            </a>
            <a href="#!" aria-label="Staffly в Telegram">
              <TelegramIcon />
            </a>
          </div>
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
