import { BlackButton } from '../../component/ui/btn/button.tsx'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportClientFailure } from '../../app/support/client-diagnostics.ts'
import { SupportReference } from '../../component/ui/request-error-message.tsx'
import './status-page.scss'

export default class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; errorId?:string }> {
  state: {failed:boolean;errorId?:string} = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Application render failed:', error, info.componentStack);this.setState({errorId:reportClientFailure('CLIENT_RUNTIME_ERROR')}) }
  render() {
    if (!this.state.failed) return this.props.children
    return <main className="status-page" role="alert"><section><span className="status-page__code">500</span><p>Произошла ошибка</p><h1>Не удалось открыть страницу</h1><p>Обновите страницу или вернитесь на главную и попробуйте снова позже.</p>{this.state.errorId&&<SupportReference value={this.state.errorId}/>}<div><BlackButton onClick={() => window.location.reload()}>Обновить</BlackButton><a className="status-page__secondary" href="/">На главную</a></div></section></main>
  }
}
