export type LiveMessage = { event: string; data: string }
export function eventParser(accept: (message: LiveMessage) => void) {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    if (buffer.length > 131072) throw new Error('Live frame is too large')
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length)
      const lines = frame.split(/\r?\n/)
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (data) accept({ event, data })
    }
  }
}

export function startLiveStream(options: {
  open: (signal: AbortSignal) => Promise<Response>
  onReady: () => void
  onChange: (hints: Array<{ topic: string; organizationId?: string }>) => void
  onOffline: () => void
}) {
  let stopped = false, controller: AbortController | undefined, retry: ReturnType<typeof setTimeout> | undefined
  let attempts = 0, lastMessage = Date.now()
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  async function connect() {
    if (stopped || !visible()) return
    lastMessage = Date.now()
    const current = new AbortController(); controller = current
    try {
      const response = await options.open(current.signal)
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Live stream unavailable')
      const parse = eventParser(({ event, data }) => {
        lastMessage = Date.now()
        if (event === 'ready' || event === 'reset') { attempts = 0; options.onReady() }
        if (event === 'change') {
          const hints = JSON.parse(data)
          if (Array.isArray(hints) && hints.length <= 100) options.onChange(hints.filter(hint => typeof hint?.topic === 'string'))
        }
      })
      const reader = response.body.getReader(), decoder = new TextDecoder()
      try {
        while (!current.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          parse(decoder.decode(value, { stream: true }))
        }
      } finally { await reader.cancel().catch(() => undefined) }
    } catch { /* Keep HTTP fallback active; retry only while the tab is visible. */ }
    finally {
      if (controller === current) {
        controller = undefined; options.onOffline()
        if (!stopped && visible()) retry = setTimeout(() => { void connect() }, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) + Math.random() * 1000)
      }
    }
  }
  const visibility = () => {
    clearTimeout(retry)
    controller?.abort(); controller = undefined
    options.onOffline()
    if (visible()) void connect()
  }
  const watchdog = setInterval(() => { if (controller && Date.now() - lastMessage > 45000) controller.abort() }, 10000)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
  void connect()
  return () => {
    stopped = true; clearTimeout(retry); clearInterval(watchdog)
    controller?.abort(); controller = undefined; options.onOffline()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
  }
}
