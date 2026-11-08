import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { pdfPageLayout } from './pdf-preview-layout'

export function PdfPreview({blob, name, onError}: {blob: Blob; name: string; onError: (message: string) => void}) {
  const host = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [pageNumber, setPageNumber] = useState(1)
  const [width, setWidth] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const node = host.current!
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    let task: PDFDocumentLoadingTask | undefined
    setPdf(undefined)
    setPageNumber(1)
    setLoading(true)
    async function load() {
      try {
        const [{loadPdf}, bytes] = await Promise.all([import('./pdf-engine'), blob.arrayBuffer()])
        if (!active) return
        task = loadPdf(new Uint8Array(bytes))
        const document = await task.promise
        if (active) setPdf(document)
      } catch (error) {
        if (!active) return
        onError(error instanceof Error && error.name === 'PasswordException'
          ? '此 PDF 已加密，请下载后输入密码打开。' : 'PDF 无法显示，请重试或下载后打开。')
        setLoading(false)
      }
    }
    void load()
    return () => { active = false; void task?.destroy().catch(() => {}) }
  }, [blob, onError])

  useEffect(() => {
    if (!pdf || !width) return
    let active = true
    let renderTask: RenderTask | undefined
    let page: PDFPageProxy | undefined
    setLoading(true)
    async function render() {
      try {
        page = await pdf!.getPage(pageNumber)
        if (!active) return
        const original = page.getViewport({scale: 1})
        const size = pdfPageLayout(original.width, original.height, width, window.devicePixelRatio || 1)
        // Each render owns a canvas, so cancellation cannot race with a new page/resize.
        const canvas = document.createElement('canvas')
        canvas.width = size.pixelWidth
        canvas.height = size.pixelHeight
        canvas.style.width = `${size.width}px`
        canvas.style.height = `${size.height}px`
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `${name}，第 ${pageNumber} 页`)
        renderTask = page.render({canvas, viewport: page.getViewport({scale: size.scale}),
          transform: [size.outputScale, 0, 0, size.outputScale, 0, 0]})
        await renderTask.promise
        if (active) host.current?.replaceChildren(canvas)
      } catch {
        if (active) {
          host.current?.replaceChildren()
          onError('PDF 页面无法显示，请重试或下载后打开。')
        }
      } finally {
        page?.cleanup()
        if (active) setLoading(false)
      }
    }
    void render()
    return () => { active = false; renderTask?.cancel() }
  }, [pdf, pageNumber, width, name, onError])

  return <div className="pdf-preview">
    <div className="pdf-preview-controls">
      <button className="btn" type="button" disabled={!pdf || loading || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}><ChevronLeft size={16}/>上一页</button>
      <span aria-live="polite">{pdf ? `第 ${pageNumber} / ${pdf.numPages} 页` : '正在读取 PDF…'}</span>
      <button className="btn" type="button" disabled={!pdf || loading || pageNumber >= pdf.numPages} onClick={() => setPageNumber(value => value + 1)}>下一页<ChevronRight size={16}/></button>
    </div>
    {loading && <p className="feedback" role="status"><LoaderCircle className="spinner" size={18}/>正在绘制 PDF…</p>}
    <div className="pdf-preview-scroll" aria-busy={loading}><div className="pdf-preview-page" ref={host}/></div>
  </div>
}
