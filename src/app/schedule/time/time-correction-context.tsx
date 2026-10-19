import { createContext, useContext } from 'react'
type TimeCorrectionContextValue = { canOpen: (locationId?: string) => boolean; open: (shiftId: string, locationId?: string) => void }
export const TimeCorrectionContext = createContext<TimeCorrectionContextValue | null>(null)
export const useTimeCorrection = () => useContext(TimeCorrectionContext)
