import { useState } from 'react'

function EyeIcon({ visible }: { visible: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" />{!visible && <path d="m3 21 18-18" />}</svg>
}

type PasswordFieldProps = { label: string; value: string; autoComplete: string; onChange: (value: string) => void }

export default function PasswordField({ label, value, autoComplete, onChange }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  return <label className="account-password-field"><span>{label}</span><div><input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} maxLength={256} required /><button type="button" aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setVisible((current) => !current)}><EyeIcon visible={visible} /></button></div></label>
}

