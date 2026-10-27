import { useEffect } from 'react'
import { startThemeSync } from './theme-store.ts'

export default function ThemeController() {
  useEffect(startThemeSync, [])
  return null
}
