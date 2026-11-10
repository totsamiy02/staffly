import { PublicContentSlot } from '../../features/public-content/content.tsx'
import './components/legal-document.scss'

export default function ContactsPage() {
  return <main className="legal-document"><div className="container legal-document__container">
    <a className="legal-document__back" href="/">Вернуться на главную</a>
    <PublicContentSlot name="contacts"><h1>Контакты</h1><p>Контакты владельца сервиса пока не опубликованы.</p></PublicContentSlot>
  </div></main>
}
