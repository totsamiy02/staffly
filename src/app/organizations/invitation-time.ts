import { useEffect, useState } from 'react'

export function invitationTimeRemaining(expiresAt: string, now: number) {
  const remaining = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Срок истёк'
  const minutes = Math.ceil(remaining / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes % 1440 / 60)
  const rest = minutes % 60
  return `Осталось ${[days ? `${days} д` : '', hours ? `${hours} ч` : '', rest ? `${rest} мин` : ''].filter(Boolean).join(' ')}`
}

export function useInvitationClock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = window.setInterval(update, 15_000)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [])
  return now
}
