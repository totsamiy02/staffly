import { useState } from 'react'
import { useAuth } from '../../../app/auth/auth-context.tsx'
import Avatar from '../avatar/avatar.tsx'
import FilePicker from '../file-picker/file-picker.tsx'
import HelpTip from '../help-tip/help-tip.tsx'

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
}

export default function ImageUpload({ endpoint, imageUrl, name, avatarClassName, disabled = false, onChange, onMessage, onError }: ImageUploadProps) {
  const { apiRequest, uploadImage } = useAuth()
  const [busy, setBusy] = useState(false)

  async function selectFile(file: File | undefined) {
    if (!file) return
    onError(''); onMessage('')
    if (!acceptedTypes.has(file.type)) { onError('Выберите изображение JPEG, PNG или WebP.'); return }
    if (file.size > MAX_IMAGE_BYTES) { onError('Изображение должно весить не больше 8 МБ.'); return }
    setBusy(true)
    try {
      const result = await uploadImage<{ avatarUrl?: string; logoUrl?: string }>(endpoint, file)
      const url = result.avatarUrl ?? result.logoUrl
      if (!url) throw new Error('Сервер не вернул адрес изображения.')
      await onChange(url)
      onMessage('Изображение обновлено.')
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Не удалось загрузить изображение.')
    } finally { setBusy(false) }
  }

  async function remove() {
    onError(''); onMessage(''); setBusy(true)
    try {
      await apiRequest(endpoint, { method: 'DELETE' })
      await onChange(null)
      onMessage('Изображение удалено.')
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Не удалось удалить изображение.')
    } finally { setBusy(false) }
  }

  return <div className="image-upload">
    <div className="image-upload__preview"><Avatar url={imageUrl} name={name} className={avatarClassName} eager /></div>
    {!disabled && <><div className="image-upload__actions">
<FilePicker compact value={[]} label="Фотография" buttonLabel={busy ? 'Обрабатываем…' : imageUrl ? 'Заменить фото' : 'Загрузить фото'} accept="image/jpeg,image/png,image/webp" maxBytes={MAX_IMAGE_BYTES} disabled={busy} onChange={files => void selectFile(files[0])}/>
      {imageUrl && <button className="image-upload__remove" type="button" disabled={busy} onClick={() => void remove()}>Удалить</button>}
    </div>
    <HelpTip label="Требования к фотографии">JPEG, PNG или WebP, до 8 МБ. Фото будет обрезано до квадрата.</HelpTip></>}
  </div>
}
