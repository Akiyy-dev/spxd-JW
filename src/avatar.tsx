import {useEffect, useRef, useState} from 'react'
import {Camera, Trash2} from 'lucide-react'
import {api, errorMessage, useQuery} from './api'
import {createFilePreview} from './file-preview'
import {avatarCrop, avatarFileKind, cropAvatar} from './avatar-image'
import {Feedback, Field, Modal, Panel} from './ui'
import type {User} from './types'
import './avatar.css'

export function Avatar({id, name, className = ''}: {id?: string | null; name: string; className?: string}) {
  const [preview, setPreview] = useState<{id: string; url: string}>()
  useEffect(() => {
    setPreview(undefined)
    if (!id) return
    const controller = new AbortController()
    let release: (() => void) | undefined
    createFilePreview(id, controller.signal).then(value => {
      if (controller.signal.aborted) {value.dispose(); return}
      release = value.dispose
      setPreview({id, url:value.url})
    }).catch(() => {})
    return () => {controller.abort(); release?.()}
  }, [id])
  return <span className={'avatar ' + className}>{preview?.id === id && preview?.url
    ? <img src={preview.url} alt="" onError={() => setPreview(undefined)}/>
    : name.slice(0,1)}</span>
}

type SelectedAvatar = {file: File; url: string; image: HTMLImageElement; kind: 'static' | 'gif'}

export function PersonalAvatar({user, update}: {user: User; update: (user: User) => void}) {
  const storage = useQuery<{cosConfigured: boolean}>(user.mustChangePassword ? null : '/status')
  const [selected, setSelected] = useState<SelectedAvatar>()
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => {mounted.current = true; return () => {mounted.current = false}}, [])
  useEffect(() => () => {if (selected) URL.revokeObjectURL(selected.url)}, [selected])

  async function choose(file?: File) {
    if (!file) return
    setLoading(true)
    setError('')
    setNotice('')
    let url: string | undefined
    try {
      const kind = avatarFileKind(file)
      url = URL.createObjectURL(file)
      const image = new Image()
      image.src = url
      await image.decode()
      if (kind === 'static') avatarCrop(image.naturalWidth, image.naturalHeight)
      if (!mounted.current) {URL.revokeObjectURL(url); return}
      setSelected({file, url, image, kind})
    } catch (error) {
      if (url) URL.revokeObjectURL(url)
      if (mounted.current) setError(error instanceof DOMException ? '图片无法读取，请选择完整有效的图片。' : errorMessage(error))
    } finally {if (mounted.current) setLoading(false)}
  }
  async function remove() {
    setRemoving(true)
    setError('')
    setNotice('')
    try {
      const {user: changed} = await api<{user: User}>('/auth/avatar', 'PUT', {avatarFileId:null, version:user.version})
      update(changed)
      setNotice('头像已移除。')
    } catch (error) {setError(errorMessage(error))} finally {setRemoving(false)}
  }
  return <Panel title="个人头像" detail="设置头像后，班级成员可在登录后看到。">
    <div className="personal-avatar-row">
      <Avatar id={user.mustChangePassword ? null : user.avatarFileId} name={user.name} className="personal-avatar"/>
      <div className="stack avatar-controls">
        <p className="muted">支持 JPG、PNG、WebP 和 GIF，原图不超过 5 MiB。静态原图不超过 4000 万像素，裁剪为 1024 × 1024；GIF 保留原始尺寸和动画，建议使用方形图片。</p>
        {user.mustChangePassword ? <p className="muted">请先修改初始密码，再设置个人头像。</p> : <>
          <div className="actions">
            <label className={'btn avatar-file-button' + (!storage.data?.cosConfigured || loading || removing ? ' disabled' : '')}>
              <Camera size={17}/>{loading ? '正在读取图片…' : user.avatarFileId ? '更换头像' : '上传头像'}
              <input aria-label="选择头像图片" type="file" accept=".jpg,.jpeg,.png,.webp,.gif" disabled={!storage.data?.cosConfigured || loading || removing}
                onChange={event => {void choose(event.target.files?.[0]); event.currentTarget.value = ''}}/>
            </label>
            {user.avatarFileId && <button className="btn quiet" disabled={loading || removing} onClick={() => void remove()}><Trash2 size={17}/>{removing ? '正在移除…' : '移除头像'}</button>}
          </div>
          {storage.data && !storage.data.cosConfigured && <p className="muted">头像上传暂不可用，请管理员完成腾讯云 COS 存储配置。</p>}
          <Feedback error={storage.error} loading={storage.loading} retry={storage.reload}/>
        </>}
      </div>
    </div>
    <Feedback error={error}/>{notice && <p className="feedback" role="status">{notice}</p>}
    {selected && <AvatarEditor selected={selected} user={user} close={() => setSelected(undefined)} saved={changed => {
      update(changed)
      setSelected(undefined)
      setNotice('头像已更新。')
    }}/>}
  </Panel>
}

function AvatarEditor({selected, user, close, saved}: {selected: SelectedAvatar; user: User; close: () => void; saved: (user: User) => void}) {
  const [zoom, setZoom] = useState(1)
  const [x, setX] = useState(.5)
  const [y, setY] = useState(.5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const gif = selected.kind === 'gif'
  const crop = gif ? null : avatarCrop(selected.image.naturalWidth, selected.image.naturalHeight, zoom, x, y)
  async function save() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const file = gif ? selected.file : await cropAvatar(selected.image, zoom, x, y)
      const upload = await api<{fileId: string; url: string; headers: Record<string,string>}>('/files/upload', 'POST', {
        name:file.name, size:file.size, mime:file.type, purpose:'avatar', entityId:user.id,
      })
      const result = await fetch(upload.url, {method:'PUT', headers:upload.headers, body:file})
      if (!result.ok) throw new Error('头像上传失败，请重试。')
      await api('/files/' + upload.fileId + '/confirm', 'POST')
      const {user: changed} = await api<{user: User}>('/auth/avatar', 'PUT', {avatarFileId:upload.fileId, version:user.version})
      saved(changed)
    } catch (error) {setError(errorMessage(error))} finally {setBusy(false)}
  }
  return <Modal title={gif ? '预览动态头像' : '裁剪头像'} close={() => {if (!busy) close()}}>
    <div className="stack avatar-editor">
      <div className={'avatar-crop-preview' + (gif ? ' gif-preview' : '')}>
        <img src={selected.url} alt={gif ? '动态头像预览' : '头像裁剪预览'} style={crop ? {
          width:(selected.image.naturalWidth/crop.size*100)+'%', height:(selected.image.naturalHeight/crop.size*100)+'%',
          left:(-crop.x/crop.size*100)+'%', top:(-crop.y/crop.size*100)+'%',
        } : undefined}/>
      </div>
      {gif ? <p className="muted">GIF 将保留原文件的尺寸、帧和播放效果；头像区域居中显示。建议上传 1024 × 1024 的方形动图。</p> : <>
        <p className="muted">调整位置和缩放，保存为 1024 × 1024 像素的清晰头像。</p>
        <fieldset disabled={busy} className="avatar-crop-fields">
          <Field label="缩放"><input type="range" min="1" max="3" step="0.01" value={zoom} onChange={event => setZoom(Number(event.target.value))}/></Field>
          <Field label="水平位置"><input type="range" min="0" max="1" step="0.01" value={x} onChange={event => setX(Number(event.target.value))}/></Field>
          <Field label="垂直位置"><input type="range" min="0" max="1" step="0.01" value={y} onChange={event => setY(Number(event.target.value))}/></Field>
        </fieldset>
      </>}
      <Feedback error={error}/>
      <div className="actions"><button className="btn" disabled={busy} onClick={close}>取消</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存头像'}</button></div>
    </div>
  </Modal>
}
