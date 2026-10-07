import { deliverEventStarts } from './service.ts'
export function startEventNotifications() {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await deliverEventStarts() } catch (error) { console.error('Event start notifications failed:', error) } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 30000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
