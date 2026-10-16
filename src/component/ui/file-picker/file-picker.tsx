import { useId, useRef, useState } from 'react'
import HelpTip from '../help-tip/help-tip.tsx'
import './file-picker.scss'

const fileSizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`
type Props = { value: File[]; onChange: (files: File[]) => void; accept?: string; multiple?: boolean; maxFiles?: number; maxBytes?: number; disabled?: boolean; label?: string; hint?: string; compact?: boolean; buttonLabel?: string }
export default function FilePicker({ value, onChange, accept, multiple = false, maxFiles = multiple ? 5 : 1, maxBytes, disabled = false, label = 'Вложения', hint, compact = false, buttonLabel }: Props) {
  const input = useRef<HTMLInputElement>(null), id = useId()
  const [dragging, setDragging] = useState(false), [error, setError] = useState('')
  function choose(files: File[]) {
    if (disabled || !files.length) return
    setError('')
    const next = multiple ? [...value, ...files.filter(file => !value.some(old => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified))] : files
    if (next.length > maxFiles) { setError(maxFiles === 1 ? 'Выберите один файл.' : `Можно добавить ещё файлов: ${Math.max(0, maxFiles - value.length)}.`); return }
    if (maxBytes && next.some(file => file.size > maxBytes)) { setError(`Каждый файл должен весить не больше ${fileSizeLabel(maxBytes)}.`); return }
    onChange(next)
  }
  return <div className={`staffly-file-picker${compact ? ' staffly-file-picker--compact' : ''}${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); choose(Array.from(event.dataTransfer.files)) }}>
    <input ref={input} id={id} type="file" hidden tabIndex={-1} accept={accept} multiple={multiple} disabled={disabled} onChange={event => { choose(Array.from(event.target.files ?? [])); event.target.value = '' }}/>
    <div className="staffly-file-picker__control"><span className="staffly-file-picker__icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/><path d="m6 14 8-8"/></svg></span><span className="staffly-file-picker__text"><strong>{label}{hint && <HelpTip label={`О файлах: ${label}`}>{hint}</HelpTip>}</strong>{!compact && <small>{value.length ? `Выбрано: ${value.length}${multiple ? ` / ${maxFiles}` : ''}` : 'Перетащите сюда или выберите файл'}</small>}</span><button type="button" className="app-secondary" disabled={disabled || multiple && value.length >= maxFiles} onClick={() => input.current?.click()}>{buttonLabel ?? (value.length ? multiple ? 'Добавить' : 'Заменить' : multiple ? 'Выбрать файлы' : 'Выбрать файл')}</button></div>
    {!!value.length && !compact && <ul className="staffly-file-picker__files">{value.map((file, index) => <li key={`${file.name}:${file.size}:${index}`}><span className="staffly-file-picker__format">{file.name.split('.').at(-1)?.slice(0, 5).toUpperCase()}</span><span><strong>{file.name}</strong><small>{fileSizeLabel(file.size)}</small></span><button type="button" aria-label={`Убрать файл ${file.name}`} disabled={disabled} onClick={() => { setError(''); onChange(value.filter((_, i) => i !== index)) }}>×</button></li>)}</ul>}
    {error && <p className="form-inline-error" role="alert">{error}</p>}
  </div>
}
