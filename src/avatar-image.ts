export const maxAvatarBytes = 5 * 1024 * 1024
export const avatarSize = 1024
const avatarTypes: Record<string, string> = {jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif'}

export function avatarFileKind(file: {name: string; size: number; type: string}): 'static' | 'gif' {
  if (file.size <= 0 || file.size > maxAvatarBytes) throw new Error('请选择非空且不超过 5 MiB 的头像图片。')
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const expected = avatarTypes[extension]
  if (!expected || (file.type && file.type !== expected)) throw new Error('头像支持 JPG、PNG、WebP 和 GIF，请选择对应格式的图片。')
  return extension === 'gif' ? 'gif' : 'static'
}

export function avatarCrop(width: number, height: number, zoom = 1, x = .5, y = .5) {
  if (![width,height,zoom,x,y].every(Number.isFinite) || width <= 0 || height <= 0 || width * height > 40_000_000) {
    throw new Error('图片尺寸无效或过大，请选择不超过 4000 万像素的图片。')
  }
  if (zoom < 1 || zoom > 3 || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('裁剪位置无效。')
  const size = Math.min(width,height) / zoom
  return {x:(width-size)*x, y:(height-size)*y, size}
}

export async function cropAvatar(image: HTMLImageElement, zoom: number, x: number, y: number): Promise<File> {
  const crop = avatarCrop(image.naturalWidth, image.naturalHeight, zoom, x, y)
  const canvas = document.createElement('canvas')
  canvas.width = avatarSize
  canvas.height = avatarSize
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片，请使用其他浏览器重试。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, avatarSize, avatarSize)
  const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(value => {
    if (value) resolve(value)
    else reject(new Error('图片处理失败，请重新选择图片。'))
  }, 'image/webp', .9))
  if (blob.size > maxAvatarBytes) throw new Error('处理后的头像超过 5 MiB，请选择更小的图片。')
  // Browsers may fall back to PNG when WebP encoding is unavailable.
  return new File([blob], blob.type === 'image/webp' ? 'avatar.webp' : 'avatar.png', {type:blob.type})
}
