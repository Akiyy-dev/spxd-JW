import { ApiError } from './api'

export const isPreviewableMime = (mime: string): boolean =>
  ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mime)

export async function createFilePreview(id: string, signal?: AbortSignal) {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/preview`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  })
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('class-session-expired'))
    const data = await response.json().catch(() => null)
    throw new ApiError(data?.message || `预览加载失败（${response.status}）`, response.status)
  }
  const blob = await response.blob()
  signal?.throwIfAborted()
  if (!isPreviewableMime(blob.type)) throw new Error('此文件类型暂不支持预览，请下载后打开。')
  const url = URL.createObjectURL(blob)
  return {url, blob, mime: blob.type, dispose: () => URL.revokeObjectURL(url)}
}
