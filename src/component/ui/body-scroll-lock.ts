type ScrollBody = { style: { overflow: string } }
const locks = new WeakMap<ScrollBody, { count: number; original: string }>()
// Multiple dialogs may overlap during their closing animation or navigation.
export function lockBodyScroll(body: ScrollBody = document.body) {
  const lock = locks.get(body) ?? { count: 0, original: body.style.overflow }
  lock.count++
  locks.set(body, lock)
  body.style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    if (--lock.count === 0) { body.style.overflow = lock.original; locks.delete(body) }
  }
}
