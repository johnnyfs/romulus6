import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  resetKey?: string | number
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div style={{ padding: 24, color: 'var(--text)', background: 'var(--bg)', minHeight: '100vh' }}>
          <h2 style={{ color: '#fda29b', marginBottom: 8 }}>Something went wrong</h2>
          <pre style={{ color: 'var(--text-dim)', fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16,
              padding: '6px 14px',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
              marginRight: 8,
            }}
          >
            Retry
          </button>
          <button
            onClick={() => { window.location.href = '/workspaces' }}
            style={{
              marginTop: 16,
              padding: '6px 14px',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Back to workspaces
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
