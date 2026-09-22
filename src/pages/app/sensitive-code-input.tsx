import { useRef } from 'react'

type SensitiveCodeInputProps = {
  value: string
  onChange: (value: string) => void
  label: string
}

export default function SensitiveCodeInput({ value, onChange, label }: SensitiveCodeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return <div className="sensitive-code" onClick={() => inputRef.current?.focus()}>
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      pattern="[0-9]{6}"
      maxLength={6}
      autoComplete="one-time-code"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
      required
    />
    <div className="sensitive-code__cells" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <span className={index === value.length ? 'sensitive-code__cell sensitive-code__cell--active' : 'sensitive-code__cell'} key={index}>{value[index] ?? ''}</span>)}
    </div>
  </div>
}
