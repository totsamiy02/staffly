import { useRef } from 'react'

type CodeInputProps = {
  value: string
  onChange: (value: string) => void
  label: string
}

export default function CodeInput({ value, onChange, label }: CodeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return <div className="auth__code-input" onClick={() => inputRef.current?.focus()}>
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
    <div className="auth__code-cells" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <span className={index === value.length ? 'auth__code-cell auth__code-cell--active' : 'auth__code-cell'} key={index}>{value[index] ?? ''}</span>)}
    </div>
  </div>
}
