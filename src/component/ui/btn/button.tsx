import type { ReactNode } from 'react'
import './button.scss'

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
}

export function WhiteButton({ children, onClick }: ButtonProps) {
  return (
    <button className="button button--white" type="button" onClick={onClick}>
      {children}
    </button>
  )
}

export function BlackButton({ children, onClick }: ButtonProps) {
  return (
    <button className="button button--black" type="button" onClick={onClick}>
      {children}
    </button>
  )
}
