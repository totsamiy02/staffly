import type { ButtonHTMLAttributes } from 'react'
import yandexMark from '../../assets/images/logo/yandex-mark.svg'
import yandexLogo from '../../assets/images/logo/yandex-id.svg'
import yandexSignIn from '../../assets/images/logo/yandex-id-sign-in.svg'
import './yandex-button.scss'

// Official artwork from Yandex ID's design documentation; do not replace with a font glyph.
export function YandexMark() {
  return <span className="yandex-mark" aria-hidden="true"><img src={yandexMark} alt="" draggable={false} /></span>
}
export function YandexLogo() {
  return <img className="yandex-id-logo" src={yandexLogo} alt="Яндекс ID" draggable={false} />
}
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { busy?: boolean }
export default function YandexButton({ className = '', busy = false, disabled, type = 'button', ...props }: Props) {
  return <button type={type} className={`yandex-button ${className}`} aria-label={busy ? 'Переходим в Яндекс ID…' : 'Войти с Яндекс ID'} aria-busy={busy || undefined} disabled={disabled || busy} {...props}><img className="yandex-button__artwork" src={yandexSignIn} alt="" aria-hidden="true" draggable={false} /></button>
}
