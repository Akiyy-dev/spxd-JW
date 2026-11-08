import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Keep font maps and image decoders on this origin, including PDFs using CJK fonts.
const assets = import.meta.glob<string>([
  '../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../node_modules/pdfjs-dist/wasm/*.{wasm,js}',
], {eager: true, query: '?url', import: 'default'})

class BundledPdfData {
  async fetch({kind, filename}: {kind: string; filename: string}) {
    const folders: Record<string, string> = {cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm'}
    const folder = folders[kind]
    const url = folder && assets[`../node_modules/pdfjs-dist/${folder}/${filename}`]
    if (!url) throw new Error('PDF 预览资源不存在')
    const response = await fetch(url, {credentials: 'same-origin'})
    if (!response.ok) throw new Error('PDF 预览资源加载失败')
    return new Uint8Array(await response.arrayBuffer())
  }
}

export function loadPdf(data: Uint8Array) {
  GlobalWorkerOptions.workerSrc = workerUrl
  return getDocument({data, useWorkerFetch: false, BinaryDataFactory: BundledPdfData,
    canvasMaxAreaInBytes: 16 * 1024 * 1024, enableXfa: false})
}
