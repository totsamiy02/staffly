import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { reportClientFailure } from '../../../app/support/client-diagnostics.ts'
import { SupportReference } from '../../../component/ui/request-error-message.tsx'

type Props = {
  children: ReactNode
  organizationPath: string
}

type State = {
  failed: boolean
  errorId?:string
}

export default class ModuleErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workspace module failed:', error, info.componentStack)
    this.setState({errorId:reportClientFailure('CLIENT_RUNTIME_ERROR')})
  }

  render() {
    if (!this.state.failed) return this.props.children

    return <section className="workspace-problem" role="alert">
      <p className="app-eyebrow">Раздел временно недоступен</p>
      <h1>Не удалось открыть страницу</h1>
      <p>Остальные разделы организации продолжают работать. Попробуйте открыть этот раздел ещё раз.</p>
      {this.state.errorId&&<SupportReference value={this.state.errorId}/>}
      <div>
        <button className="app-primary" type="button" onClick={() => this.setState({ failed: false })}>Попробовать снова</button>
        <Link className="app-secondary" to={this.props.organizationPath}>На главную организации</Link>
      </div>
    </section>
  }
}
