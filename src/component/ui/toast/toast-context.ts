import { createContext, useContext, useEffect, type ReactNode } from 'react'
type Kind = 'success' | 'error' | 'info'
export const ToastContext = createContext<(message: string, kind?: Kind) => void>(() => {})
export function useToast() { return useContext(ToastContext) }
export type FloatingMessage = { id: string; content: ReactNode; duration: number; className: string }
export const FloatingMessagesContext = createContext<{ enqueue: (message: FloatingMessage) => void; dismiss: (id: string) => void; remove: (id: string) => void }>({ enqueue: () => {}, dismiss: () => {}, remove: () => {} })
export function useFloatingMessages() { return useContext(FloatingMessagesContext) }
export function useToastFeedback(message: string, error?: string) {
  const toast = useToast()
  useEffect(() => { if (message) toast(message, 'success') }, [message, toast])
  useEffect(() => { if (error) toast(error, 'error') }, [error, toast])
}
