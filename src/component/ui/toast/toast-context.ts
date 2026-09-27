import { createContext, useContext, useEffect } from 'react'
type Kind = 'success' | 'error' | 'info'
export const ToastContext = createContext<(message: string, kind?: Kind) => void>(() => {})
export function useToast() { return useContext(ToastContext) }
export function useToastFeedback(message: string, error?: string) {
  const toast = useToast()
  useEffect(() => { if (message) toast(message, 'success') }, [message, toast])
  useEffect(() => { if (error) toast(error, 'error') }, [error, toast])
}
