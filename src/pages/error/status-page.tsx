import { Link } from 'react-router-dom'
import './status-page.scss'

export default function StatusPage({ status = 404 }: { status?: 404 | 500 }) {
  const missing = status === 404
  return <main className="status-page" role="main">
    <section>
      <span>{status}</span>
      <p>{missing ? 'Страница не найдена' : 'Произошла ошибка'}</p>
      <h1>{missing ? 'Такой страницы нет' : 'Не удалось открыть страницу'}</h1>
      <p>{missing ? 'Возможно, ссылка устарела или в адресе есть ошибка.' : 'Обновите страницу или попробуйте снова немного позже.'}</p>
      <div><Link className="button button--black" to="/">На главную</Link><Link className="status-page__secondary" to="/app">Мои организации</Link></div>
    </section>
  </main>
}
