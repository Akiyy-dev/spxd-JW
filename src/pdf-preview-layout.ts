export function pdfPageLayout(pageWidth: number, pageHeight: number, availableWidth: number, pixelRatio = 1) {
  if (![pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('PDF 页面尺寸无效')
  }
  const limit = 8192
  const scale = Math.min(Math.max(1, availableWidth) / pageWidth, limit / pageWidth, limit / pageHeight)
  const width = pageWidth * scale
  const height = pageHeight * scale
  const outputScale = Math.min(Math.max(1, pixelRatio), 2, Math.sqrt(4 * 1024 * 1024 / (width * height)), limit / width, limit / height)
  return {scale, width, height, outputScale,
    pixelWidth: Math.max(1, Math.floor(width * outputScale)),
    pixelHeight: Math.max(1, Math.floor(height * outputScale))}
}
