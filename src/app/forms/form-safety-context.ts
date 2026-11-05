import { createContext, useContext } from 'react'
export type FormGuard = { dirty: boolean; busy: boolean; element?: HTMLElement | null; saveDraft?: () => boolean; discard: () => void }
export type FormSafety = { guards: Map<symbol, FormGuard>; confirm: (guards: FormGuard[]) => Promise<boolean>; notify: () => void }
export const FormSafetyContext = createContext<FormSafety | null>(null)
export function useFormSafetyContext() {
  const value = useContext(FormSafetyContext)
  if (!value) throw new Error('FormSafetyProvider is required')
  return value
}
