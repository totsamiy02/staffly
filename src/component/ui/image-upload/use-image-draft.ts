import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../../app/auth/auth-context.tsx'

export function useImageDraft(endpoint: string, savedUrl: string | null) {
  const { uploadImage } = useAuth()
  const [file, setFile] = useState<File | null | undefined>()
  const [preview, setPreview] = useState<string | null>(null)
  const staged = useRef<{ file: File; id: string } | null>(null)
  const reset = useCallback(() => { staged.current = null; setFile(undefined) }, [])
  const change = useCallback((next: File | null) => { staged.current = null; setFile(next) }, [])
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file); setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  return {
    url: file === undefined ? savedUrl : file === null ? null : preview,
    change,
    reset,
    async prepare(): Promise<string | null | undefined> {
      if (!file) return file
      if (staged.current?.file === file) return staged.current.id
      const result = await uploadImage<{ uploadId: string }>(endpoint + '/stage', file)
      staged.current = { file, id: result.uploadId }
      return result.uploadId
    },
  }
}
