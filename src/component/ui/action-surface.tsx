import type { ButtonHTMLAttributes } from 'react'
import './action-surface.scss'

/** A row/card with a primary action and independent, accessible controls inside it. */
export default function ActionSurface({ children, className = '', style, title, disabled, ...action }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const dataAttributes = Object.fromEntries(Object.entries(action).filter(([key]) => key.startsWith('data-')))
  const buttonAttributes = Object.fromEntries(Object.entries(action).filter(([key]) => !key.startsWith('data-')))
  return <div {...dataAttributes} className={`staffly-action-surface ${className}`} style={style} title={title} data-disabled={disabled || undefined}>
    {children}
    <button {...buttonAttributes} type="button" disabled={disabled} className="staffly-action-surface__open" />
  </div>
}
