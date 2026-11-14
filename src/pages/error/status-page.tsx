import { Link } from 'react-router-dom'
import '../../component/ui/btn/button.scss'
import './status-page.scss'

export default function StatusPage({ status = 404 }: { status?: 404 | 500 }) {
  const missing = status === 404
  return <main className="status-page" role="main">
    <section>
      <span className="status-page__code">{status}</span>
      <p className="status-page__eyebrow">{missing ? 'Страница не найдена' : 'Произошла ошибка'}</p>
      <h1 className="status-page__title">{missing ? 'Такой страницы нет' : 'Не удалось открыть страницу'}</h1>
      <p className="status-page__description">{missing ? 'Возможно, ссылка устарела или в адресе есть ошибка.' : 'Обновите страницу или попробуйте снова немного позже.'}</p>
      <div className="status-page__actions">
        <Link className="button button--black" to="/">На главную</Link>
        <Link className="status-page__secondary" to="/app">Мои организации</Link>
      </div>
    </section>
  </main>
}
