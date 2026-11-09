import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, Download, Eye, File, Inbox, LoaderCircle, Paperclip, Upload, X } from 'lucide-react'
import { api, errorMessage, useQuery } from './api'
import { createFilePreview, isPreviewableMime } from './file-preview'
import { PdfPreview } from './pdf-preview'
import type { AttachmentPurpose, FileInfo } from './types'
import './file-preview.css'

export function PageTitle({label, title, detail, actions}: {label: string; title: string; detail: string; actions?: ReactNode}) {
  return <header className="page-title"><div><p className="eyebrow">{label}</p><h1>{title}</h1><p>{detail}</p></div>{actions && <div className="actions">{actions}</div>}</header>
}

export function Panel({title, detail, actions, children}: {title: ReactNode; detail?: string; actions?: ReactNode; children: ReactNode}) {
  return <section className="panel"><header className="panel-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{actions}</header>{children}</section>
}

export function Empty({children}: {children: ReactNode}) {
  return <div className="empty"><Inbox aria-hidden="true" size={24} /><p>{children}</p></div>
}

export function Feedback({error, loading, retry}: {error?: string; loading?: boolean; retry?: () => void}) {
  if (error) return <div className="feedback error" role="alert"><AlertCircle size={18} />{error}{retry && <button type="button" className="btn quiet" onClick={retry}>重试</button>}</div>
  return loading ? <div className="feedback" role="status"><LoaderCircle className="spinner" size={18} />正在加载…</div> : null
}

export function Badge({children, tone = ''}: {children: ReactNode; tone?: 'good' | 'warn' | 'bad' | ''}) {
  return <span className={'badge ' + tone}>{children}</span>
}

export function Field({label, children, wide, hint}: {label: string; children: ReactNode; wide?: boolean; hint?: string}) {
  return <label className={'field' + (wide ? ' wide' : '')}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

export function Modal({title, close, children, wide}: {title: string; close: () => void; children: ReactNode; wide?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return <dialog ref={ref} className={wide ? 'dialog wide-dialog' : 'dialog'} aria-labelledby={heading} onCancel={event => {event.preventDefault(); event.stopPropagation(); close()}}>
    <header className="dialog-heading"><h2 id={heading}>{title}</h2><button type="button" className="btn quiet icon" aria-label="关闭" onClick={close}><X size={20}/></button></header>
    <div className="dialog-body">{children}</div>
  </dialog>
}

export function AsyncForm({children, submit, button = '保存', cancel, danger}: {children: ReactNode; submit: (data: FormData) => Promise<unknown>; button?: string; cancel?: () => void; danger?: boolean}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (event.currentTarget.querySelector('[data-uploading="true"]')) {
      setError('请等待附件上传和校验完成。')
      return
    }
    setError('')
    setBusy(true)
    try { await submit(new FormData(event.currentTarget)) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  return <form className="async-form" onSubmit={handle}>
    <fieldset disabled={busy}>{children}</fieldset>
    <Feedback error={error} />
    <div className="actions form-actions">{cancel && <button type="button" className="btn" onClick={cancel}>取消</button>}<button className={'btn ' + (danger ? 'danger' : 'primary')} disabled={busy}>{busy && <LoaderCircle size={16} className="spinner" />}{busy ? '处理中…' : button}</button></div>
  </form>
}

export const val = (data: FormData, name: string) => String(data.get(name) ?? '').trim()
export const checked = (data: FormData, name: string) => data.has(name)

export async function openFile(id: string) {
  const {url} = await api<{url: string}>(`/files/${id}/download`, 'POST')
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.click()
}

function FilePreview({id, name, close}: {id: string; name: string; close: () => void}) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof createFilePreview>>>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let current: Awaited<ReturnType<typeof createFilePreview>> | undefined
    setPreview(undefined)
    setError('')
    createFilePreview(id, controller.signal).then(result => {
      if (controller.signal.aborted) { result.dispose(); return }
      current = result
      setPreview(result)
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    return () => { controller.abort(); current?.dispose() }
  }, [id, attempt])
  async function download() {
    setDownloading(true)
    setDownloadError('')
    try { await openFile(id) } catch (error) { setDownloadError(errorMessage(error)) } finally { setDownloading(false) }
  }
  return <Modal title={'预览 · ' + name} close={close} wide>
    <div className="stack">
      <Feedback error={error} loading={!preview && !error} retry={() => setAttempt(value => value + 1)}/>
      {preview && (preview.mime === 'application/pdf'
        ? <PdfPreview blob={preview.blob} name={name} onError={setError}/>
        : <img className="file-preview-content" src={preview.url} alt={name} onError={() => setError('图片无法显示，请重试或下载后打开。')}/>)}
      <Feedback error={downloadError}/>
      <div className="actions"><button type="button" className="btn" disabled={downloading} onClick={() => void download()}><Download size={16}/>{downloading ? '处理中…' : '下载附件'}</button></div>
    </div>
  </Modal>
}

function FileLink({id, remove}: {id: string; remove?: () => void}) {
  const info = useQuery<FileInfo>('/files/' + id)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const name = info.data?.name || (info.error ? '附件' : '正在读取附件…')
  const canPreview = !!info.data && isPreviewableMime(info.data.mime)
  async function download() {
    setBusy(true)
    setError('')
    try { await openFile(id) } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  return <div><div className="file-row"><File size={17} /><span>{name}</span>
    {canPreview && <button className="btn quiet icon" type="button" title="预览" aria-label={`预览 ${name}`} disabled={busy} onClick={() => setPreviewing(true)}><Eye size={18} /></button>}
    {info.data && !canPreview && <small className="file-download-hint">下载后查看</small>}
    <button className="btn quiet icon" type="button" title="下载" aria-label={`下载 ${name}`} disabled={busy} onClick={() => void download()}><Download size={18} /></button>
    {remove && <button className="btn quiet icon" type="button" title="移除" aria-label={`移除 ${name}`} onClick={remove}><X size={18} /></button>}
  </div><Feedback error={error}/>{previewing && <FilePreview id={id} name={name} close={() => setPreviewing(false)}/>}</div>
}

export function FileList({ids}: {ids?: string[]}) {
  return ids?.length ? <div className="files">{ids.map(id => <FileLink key={id} id={id}/>)}</div> : null
}

export function UploadFiles({ids, setIds, purpose, entityId, context, label = '附件', max = 5, required = false}: {ids: string[]; setIds: (ids: string[]) => void; purpose: AttachmentPurpose; entityId?: string; context?: string; label?: string; max?: number; required?: boolean}) {
  const maxMiB = purpose === 'avatar' ? 5 : 20
  const status = useQuery<{cosConfigured: boolean}>('/status')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setError('')
    const next = [...ids]
    try {
      if (files.length > max - ids.length) throw new Error(`还可上传 ${max - ids.length} 个文件。`)
      for (const file of Array.from(files)) {
        if (file.size === 0 || file.size > maxMiB * 1024 * 1024) throw new Error(`请选择非空且不超过 ${maxMiB} MiB 的文件。`)
        const {fileId, url, headers} = await api<{fileId: string; url: string; headers: Record<string, string>}>('/files/upload', 'POST', {name: file.name, size: file.size, mime: file.type || 'application/octet-stream', purpose, entityId, context})
        const put = await fetch(url, {method: 'PUT', headers, body: file})
        if (!put.ok) throw new Error('附件上传失败，请重试。')
        await api(`/files/${fileId}/confirm`, 'POST')
        next.push(fileId)
        setIds([...next])
      }
    } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  return <div className="upload wide" data-uploading={busy}>
    <p className="field-label"><Paperclip size={16}/>{label}{required && '（必填）'}</p>
    {purpose === 'avatar' && <p className="muted">支持 JPG、PNG、WebP、GIF，每张不超过 5 MiB。GIF 保留动画，建议使用 1024×1024 的图片。</p>}
    {ids.map(id => <FileLink key={id} id={id} remove={busy ? undefined : () => setIds(ids.filter(value => value !== id))}/>)}
    {ids.length < max && <label className={'upload-zone' + (!status.data?.cosConfigured ? ' disabled' : '')}>
      <Upload size={18}/>{busy ? '上传并校验中…' : status.loading ? '正在检查附件服务…' : status.data?.cosConfigured ? '选择文件上传' : 'COS 附件服务尚未配置'}
      <input type="file" multiple={max > 1} disabled={busy || !status.data?.cosConfigured} accept={purpose === 'avatar' ? '.jpg,.jpeg,.png,.webp,.gif' : purpose === 'class-photo' ? '.jpg,.jpeg,.png,.webp' : '.pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx'} onChange={event => {void upload(event.target.files); event.currentTarget.value = ''}} />
    </label>}
    <Feedback error={error || status.error} />
  </div>
}

export function ExportButton({path, label = '导出 Excel', body}: {path: string; label?: string; body?: unknown}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function download() {
    setBusy(true)
    setError('')
    try {
      const {fileId} = await api<{fileId: string}>(path, 'POST', body)
      await openFile(fileId)
    } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  return <div><button type="button" className="btn" onClick={() => void download()} disabled={busy}><Download size={16}/>{busy ? '生成中…' : label}</button><Feedback error={error} /></div>
}
