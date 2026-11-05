import { createContext, useContext, useLayoutEffect, type RefObject } from 'react'
import { lockBodyScroll } from '../body-scroll-lock.ts'

const dialogs: HTMLElement[] = []
export const DialogOpenerContext = createContext<HTMLElement | null | undefined>(undefined)
let pointerOpener: HTMLElement | null = null
if (typeof document !== 'undefined') {
  // Safari does not focus a button on pointer click. Remember the actual opener
  // before React commits autoFocus descendants of the new dialog.
  const pointer = (event: PointerEvent) => { pointerOpener = event.target instanceof Element ? event.target.closest<HTMLElement>('button,a[href],summary,[role="button"]') : null }
  const keyboard = () => { pointerOpener = null }
  document.addEventListener('pointerdown', pointer, true)
  document.addEventListener('keydown', keyboard, true)
  import.meta.hot?.dispose(() => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', keyboard, true) })
}
export function dialogOpener() { return pointerOpener?.isConnected ? pointerOpener : document.activeElement instanceof HTMLElement ? document.activeElement : null }
const inertLocks = new WeakMap<HTMLElement, { count: number; original: boolean }>()
const selector = 'button,a[href],input,textarea,select,summary,[tabindex],[contenteditable="true"]'
function tabbable(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert],[aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
}
function ownedPortal(dialog: HTMLElement, root: HTMLElement) {
  return [...dialog.querySelectorAll('[aria-controls],[aria-describedby]')].some(trigger => [...(trigger.getAttribute('aria-controls') ?? '').split(' '), ...(trigger.getAttribute('aria-describedby') ?? '').split(' ')].some(id => id && root.contains(document.getElementById(id))))
}

// Shared by public and workspace dialogs. Portal controls keep their own keyboard
// handling; unrelated page content is inert until every overlapping dialog closes.
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  const opener = useContext(DialogOpenerContext)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    const previous = opener !== undefined ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseScroll = lockBodyScroll(), locked = new Set<HTMLElement>()
    dialogs.push(dialog)
    const top = () => dialogs.at(-1) === dialog
    const sync = () => {
      if (!top()) return
      for (const child of document.body.children) {
        if (!(child instanceof HTMLElement) || child.contains(dialog) || child.matches('.staffly-notification-stack') || ownedPortal(dialog, child) || locked.has(child)) continue
        const lock = inertLocks.get(child) ?? { count: 0, original: child.inert }
        lock.count++; inertLocks.set(child, lock); child.inert = true; locked.add(child)
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true })
    dialog.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (!top() || event.defaultPrevented || event.key !== 'Tab' || !(event.target instanceof Node) || !dialog.contains(event.target)) return
      const items = tabbable(dialog)
      // Safari's default keyboard policy skips buttons and links. Move through
      // the dialog's actual controls explicitly so Tab cannot enter browser chrome.
      event.preventDefault()
      if (!items.length) { dialog.focus(); return }
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = current < 0 ? (event.shiftKey ? items.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + items.length) % items.length
      items[next].focus()
    }
    const focusin = (event: FocusEvent) => {
      if (!top() || !(event.target instanceof HTMLElement) || dialog.contains(event.target)) return
      const portal = [...document.body.children].find(root => root.contains(event.target as Node))
      if (portal instanceof HTMLElement && ownedPortal(dialog, portal)) return
      dialog.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('focusin', focusin)
    return () => {
      observer.disconnect(); document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin)
      const index = dialogs.indexOf(dialog); if (index >= 0) dialogs.splice(index, 1)
      for (const element of locked) { const lock = inertLocks.get(element); if (lock && --lock.count === 0) { element.inert = lock.original; inertLocks.delete(element) } }
      releaseScroll()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [ref, active, opener])
}
