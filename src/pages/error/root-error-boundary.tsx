import { Component, type ErrorInfo, type ReactNode } from 'react'
import './status-page.scss'

export default class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Application render failed:', error, info.componentStack) }
  render() {
    if (!this.state.failed) return this.props.children
    return <main className="status-page" role="alert"><section><span>500</span><p>Произошла ошибка</p><h1>Не удалось открыть страницу</h1><p>Обновите страницу или вернитесь на главную и попробуйте снова позже.</p><div><button className="button button--black" type="button" onClick={() => window.location.reload()}>Обновить</button><a className="status-page__secondary" href="/">На главную</a></div></section></main>
  }
}
