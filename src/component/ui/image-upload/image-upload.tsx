import { useRef, useState } from 'react'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Avatar from '../avatar/avatar.tsx'
import FilePicker from '../file-picker/file-picker.tsx'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

type ImageUploadProps = {
  endpoint: string
  imageUrl: string | null
  name: string
  avatarClassName: string
  disabled?: boolean
  onChange: (url: string | null) => void | Promise<void>
  onMessage: (message: string) => void
  onError: (message: string) => void
  onBusyChange?: (busy: boolean) => void
  onDraftChange?: (file: File | null) => void
  floatingControls?: boolean
}

export default function ImageUpload({ endpoint, imageUrl, name, avatarClassName, disabled = false, onChange, onMessage, onError, onBusyChange, onDraftChange, floatingControls = false }: ImageUploadProps) {
  const { apiRequest, uploadImage } = useAuth()
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  async function selectFile(file: File | undefined) {
    if (!file || disabled || busy) return
    onError(''); onMessage('')
    if (!acceptedTypes.has(file.type)) { onError('Выберите изображение JPEG, PNG или WebP.'); return }
    if (file.size > MAX_IMAGE_BYTES) { onError('Изображение должно весить не больше 8 МБ.'); return }
    if (onDraftChange) { onDraftChange(file); return }
    setBusy(true); onBusyChange?.(true)
    try {
      const result = await uploadImage<{ avatarUrl?: string; logoUrl?: string }>(endpoint, file)
      const url = result.avatarUrl ?? result.logoUrl
      if (!url) throw new Error('Сервер не вернул адрес изображения.')
      await onChange(url)
      onMessage('Изображение обновлено.')
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Не удалось загрузить изображение.')
    } finally { setBusy(false); onBusyChange?.(false) }
  }

  async function remove() {
    if (disabled || busy) return
    if (onDraftChange) { onDraftChange(null); return }
    onError(''); onMessage(''); setBusy(true); onBusyChange?.(true)
    try {
      await apiRequest(endpoint, { method: 'DELETE' })
      await onChange(null)
      onMessage('Изображение удалено.')
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Не удалось удалить изображение.')
    } finally { setBusy(false); onBusyChange?.(false) }
  }

  return <div className={`image-upload${floatingControls ? ' image-upload--floating' : ''}`}>
    <div className="image-upload__preview"><Avatar url={imageUrl} name={name} className={avatarClassName} eager /></div>
    {!disabled && floatingControls && <div className="image-upload__floating-actions"><input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { void selectFile(event.target.files?.[0]); event.target.value = '' }} /><button type="button" disabled={busy} aria-label={imageUrl ? 'Заменить фото' : 'Загрузить фото'} title="Выбрать JPEG, PNG или WebP до 8 МБ" onClick={() => picker.current?.click()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h4l2-3h4l2 3h4v13H4Z" /><circle cx="12" cy="13" r="4" /></svg></button>{imageUrl && <button type="button" disabled={busy} aria-label="Удалить фото" onClick={() => void remove()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg></button>}</div>}
    {!disabled && !floatingControls && <div className="image-upload__controls"><div className="image-upload__actions">
      <FilePicker compact value={[]} label="Фотография" buttonLabel={busy ? 'Обрабатываем…' : imageUrl ? 'Заменить фото' : 'Загрузить фото'} accept="image/jpeg,image/png,image/webp" maxBytes={MAX_IMAGE_BYTES} disabled={busy} onChange={files => void selectFile(files[0])}/>
      {imageUrl && <button className="image-upload__remove" type="button" disabled={busy} onClick={() => void remove()}>Удалить</button>}
    </div>
    <p className="image-upload__hint">JPG, PNG, WebP · до 8 МБ{onDraftChange && <><br />Фото изменится после сохранения профиля.</>}</p></div>}
  </div>
}
