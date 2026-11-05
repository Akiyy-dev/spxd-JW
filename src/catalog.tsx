import { useEffect, useState } from 'react'
import { Archive, ExternalLink, FileText, History, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserRoundPlus } from 'lucide-react'
import { api, dateCN, dateLabel, timestamp, useQuery } from './api'
import { createId } from './id'
import { roleNames, type ClassData, type Duty, type Member, type Resource, type Role, type User } from './types'
import { AsyncForm, Badge, checked, Empty, Feedback, Field, FileList, Modal, PageTitle, Panel, UploadFiles, val } from './ui'

const lines = (input: string) => input.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
const external = (url: string) => /^https?:\/\//i.test(url)

export function Resources({manager}: {manager: boolean}) {
  const list = useQuery<Resource[]>('/resources')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [from, setFrom] = useState('')
  const [archived, setArchived] = useState(false)
  const [editor, setEditor] = useState<Resource | 'new'>()
  const [history, setHistory] = useState<Resource>()
  const [notice, setNotice] = useState('')
  const categories = [...new Set(list.data?.map(item => item.category) || [])].sort()
  const items = list.data?.filter(item => (archived ? item.status === 'archived' : item.status === 'published')
    && (!category || item.category === category) && (!from || dateCN(new Date(item.updatedAt)) >= from)
    && `${item.title} ${item.description} ${item.category}`.toLowerCase().includes(search.trim().toLowerCase()))
  const close = () => setEditor(undefined)
  return <div className="stack">
    <PageTitle label="学习资料" title="资料中心" detail="查找班级文档、学习资料和常用链接。" actions={manager && <button className="btn primary" onClick={() => setEditor('new')}><Plus size={18}/>添加资料</button>} />
    <section className="panel">
      <div className="toolbar filter-bar">
        <label className="search-field"><Search size={18}/><input type="search" aria-label="搜索资料" placeholder="搜索资料…" value={search} onChange={event => setSearch(event.target.value)}/></label>
        <select aria-label="按类别筛选" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部类别</option>{categories.map(item => <option key={item}>{item}</option>)}</select>
        <label className="inline-label">更新起始日<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
        {manager && <label className="check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/>仅归档</label>}
      </div>
      <Feedback {...list} retry={list.reload}/>
      {notice && <p role="status" className="feedback">{notice}</p>}
      {items && (items.length ? <div className="resource-grid">{items.map(item => <article className="resource-card" key={item.id}>
        <div className="split"><span className="row-icon sky"><FileText size={20}/></span><div className="badge-group"><Badge>{item.category}</Badge>{item.pinned && <Badge tone="good">置顶</Badge>}{item.status === 'archived' && <Badge>已归档</Badge>}</div></div>
        <h3>{item.title}</h3><p className="muted">{timestamp(item.updatedAt)}{item.authorName && ' · ' + item.authorName}</p>
        {item.description && <p className="prose">{item.description}</p>}
        <FileList ids={item.attachments}/>
        <div className="actions">
          {external(item.url) && <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>打开外部链接</a>}
          {manager && <><button className="btn quiet" onClick={() => setEditor(item)}><Pencil size={16}/>编辑</button><button className="btn quiet" onClick={() => setHistory(item)}><History size={16}/>历史版本</button></>}
        </div>
      </article>)}</div> : <Empty>{search || category || from ? '没有符合筛选条件的资料。' : archived ? '暂无归档资料。' : '暂无已发布的资料。'}</Empty>)}
    </section>
    {editor && <ResourceEditor item={editor === 'new' ? undefined : editor} close={close} saved={() => {close(); list.reload(); setNotice('资料已保存。')}}/>}
    {history && <ResourceHistory item={history} close={() => setHistory(undefined)}/>}
  </div>
}

function ResourceEditor({item, close, saved}: {item?: Resource; close: () => void; saved: () => void}) {
  const [attachments, setAttachments] = useState(item?.attachments || [])
  return <Modal title={item ? '编辑资料' : '添加资料'} close={close}>
    <AsyncForm cancel={close} submit={async data => {
      const url = val(data, 'url')
      if (url && !external(url)) throw new Error('请输入以 https:// 或 http:// 开头的链接。')
      const changes = {title: val(data, 'title'), category: val(data, 'category'), url, description: val(data, 'description'), pinned: checked(data, 'pinned'), status: val(data, 'status'), attachments}
      if (item) await api('/resources/' + item.id, 'PUT', {changes, version: item.version})
      else await api('/resources', 'POST', changes)
      saved()
    }}>
      <div className="form-grid">
        <Field label="资料标题" wide><input name="title" required maxLength={150} defaultValue={item?.title}/></Field>
        <Field label="类别"><input name="category" required maxLength={50} defaultValue={item?.category || '学习资料'}/></Field>
        <Field label="发布状态"><select name="status" defaultValue={item?.status || 'published'}><option value="published">已发布</option><option value="archived">归档（下架）</option></select></Field>
        <Field label="资料说明" wide><textarea name="description" rows={4} maxLength={5000} defaultValue={item?.description}/></Field>
        <Field label="外部链接" wide><input type="url" name="url" maxLength={2000} defaultValue={item?.url}/></Field>
        <label className="check wide"><input name="pinned" type="checkbox" defaultChecked={item?.pinned}/>在资料列表置顶</label>
        <UploadFiles purpose="resource" entityId={item?.id} ids={attachments} setIds={setAttachments}/>
      </div>
    </AsyncForm>
  </Modal>
}

function ResourceHistory({item, close}: {item: Resource; close: () => void}) {
  const history = useQuery<Resource[]>('/resources/' + item.id + '/history')
  return <Modal title={'历史版本 · ' + item.title} close={close}>
    <div className="stack"><Feedback {...history} retry={history.reload}/>
      {history.data && (history.data.length ? history.data.map(version => <article className="nested-panel" key={version.version}>
        <div className="split"><strong>{version.title}</strong><Badge>第 {version.version} 版</Badge></div><p className="muted">{timestamp(version.updatedAt)} · {version.category}</p>
        <p className="prose">{version.description}</p>
        {external(version.url) && <a className="text-link" href={version.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>打开该版本链接</a>}
        <FileList ids={version.attachments}/>
      </article>) : <Empty>尚无历史版本。</Empty>)}
    </div>
  </Modal>
}

function MemberAvatar({member}: {member: Member}) {
  const [url, setUrl] = useState('')
  const id = member.avatarFileId
  useEffect(() => {
    if (!id) return
    let active = true
    api<{url: string; previewAvailable: boolean}>('/files/' + id + '/download', 'POST', {preview: true}).then(result => {
      if (active && result.previewAvailable) setUrl(result.url)
    }).catch(() => {})
    return () => {active = false}
  }, [id])
  return <span className="avatar member-avatar">{url ? <img src={url} alt="" onError={() => setUrl('')}/> : member.name.slice(0, 1)}</span>
}

export function ClassPage({manager, changed}: {manager: boolean; changed: () => void}) {
  const info = useQuery<ClassData>('/class')
  const [editor, setEditor] = useState<'settings' | 'duties' | Member>()
  const [notice, setNotice] = useState('')
  const data = info.data
  const close = () => setEditor(undefined)
  const saved = () => {close(); info.reload(); changed(); setNotice('班级信息已更新。')}
  const committees = data?.members.filter(member => member.role === 'committee')
  return <div className="stack">
    <PageTitle label="班级生活" title="班级信息" detail="查阅班级简介、班委分工、成员信息和值日安排。" actions={manager && data && <button className="btn primary" onClick={() => setEditor('settings')}><Pencil size={16}/>编辑班级设置</button>}/>
    <Feedback {...info} retry={info.reload}/>
    {notice && <p className="feedback" role="status">{notice}</p>}
    {data && <>
      <Panel title={data.config.name} detail={data.config.subtitle || data.config.academicYear}>
        <div className="badge-group"><Badge>{data.config.academicYear}</Badge><Badge>{data.config.semesterStart} 至 {data.config.semesterEnd}</Badge></div>
        <p className="prose">{data.config.introduction || '班级简介待补充。'}</p>
        {data.config.photoFileId && <img className="class-photo" alt="班级照片" src={'/api/public/photo/' + data.config.photoFileId}/>}
      </Panel>
      <div className="dashboard-grid">
        <Panel title="班委分工" detail="班级日常事务的联系人">
          {committees?.length ? <div className="rows">{committees.map(member => <div key={member.id} className="list-row"><MemberAvatar member={member}/><span><strong>{member.name}</strong><small>{member.position || '班委'}</small></span>{manager && <button className="btn quiet row-tail" onClick={() => setEditor(member)}>编辑</button>}</div>)}</div> : <Empty>暂无班委分工记录。</Empty>}
        </Panel>
        <Panel title="值日安排" detail="按日期查看区域与负责成员" actions={manager && <button className="btn quiet" onClick={() => setEditor('duties')}>编辑安排</button>}>
          {data.duties.length ? <div className="rows">{[...data.duties].sort((a,b) => a.date.localeCompare(b.date)).map(duty => <div className="list-row" key={duty.id}><span><strong>{duty.area}</strong><small>{dateLabel(duty.date)} · {duty.names.join('、') || '待分配'}</small></span></div>)}</div> : <Empty>暂无值日安排。</Empty>}
        </Panel>
      </div>
      <Panel title="班级成员" detail={`在册成员 ${data.members.length} 人`}>
        {data.members.length ? <div className="member-grid">{data.members.map(member => <div className="member-card" key={member.id}><MemberAvatar member={member}/><div><strong>{member.name}</strong><small>{member.position || roleNames[member.role]}</small></div>{manager && <button aria-label={`编辑 ${member.name}`} className="btn quiet icon row-tail" onClick={() => setEditor(member)}><Pencil size={16}/></button>}</div>)}</div> : <Empty>暂无成员信息。</Empty>}
      </Panel>
    </>}
    {data && editor === 'settings' && <ClassSettings data={data} close={close} saved={saved}/>}
    {data && editor === 'duties' && <DutyEditor data={data} close={close} saved={saved}/>}
    {data && editor && typeof editor !== 'string' && <MemberEditor data={data} member={editor} close={close} saved={saved}/>}
  </div>
}

function ClassSettings({data, close, saved}: {data: ClassData; close: () => void; saved: () => void}) {
  const config = data.config
  const [photo, setPhoto] = useState(config.photoFileId ? [config.photoFileId] : [])
  return <Modal title="班级设置" close={close}>
    <AsyncForm cancel={close} submit={async form => {
      await api('/class', 'PUT', {version: data.version, config: {name: val(form, 'name'), subtitle: val(form, 'subtitle'), introduction: val(form, 'introduction'), academicYear: val(form, 'academicYear'), semesterStart: val(form, 'semesterStart'), semesterEnd: val(form, 'semesterEnd'), holidays: [...new Set(lines(val(form, 'holidays')))], photoFileId: photo[0] || ''}})
      saved()
    }}>
      <div className="form-grid">
        <Field label="班级名称"><input name="name" required maxLength={60} defaultValue={config.name}/></Field>
        <Field label="学年"><input name="academicYear" maxLength={60} defaultValue={config.academicYear}/></Field>
        <Field label="班级副标题" wide><input name="subtitle" maxLength={150} defaultValue={config.subtitle}/></Field>
        <Field label="公开简介" wide><textarea name="introduction" rows={5} maxLength={10000} defaultValue={config.introduction}/></Field>
        <Field label="学期开始"><input type="date" name="semesterStart" required defaultValue={config.semesterStart}/></Field>
        <Field label="学期结束"><input type="date" name="semesterEnd" required defaultValue={config.semesterEnd}/></Field>
        <Field label="休课日期" wide hint="每行填写一个日期，格式为 YYYY-MM-DD。"><textarea name="holidays" rows={4} defaultValue={config.holidays.join('\n')}/></Field>
        <UploadFiles ids={photo} setIds={setPhoto} purpose="class-photo" entityId="class" label="公开班级照片" max={1}/>
      </div>
    </AsyncForm>
  </Modal>
}

function DutyEditor({data, close, saved}: {data: ClassData; close: () => void; saved: () => void}) {
  const [duties, setDuties] = useState(() => data.duties.map(duty => ({...duty, nameText: duty.names.join('、')})))
  return <Modal title="值日安排" close={close} wide>
    <AsyncForm cancel={close} submit={async () => {
      const next: Duty[] = duties.map(({nameText, ...duty}) => ({...duty, area: duty.area.trim(), names: nameText.split(/[、，,]/).map(name => name.trim()).filter(Boolean)}))
      await api('/class', 'PUT', {version: data.version, duties: next})
      saved()
    }}>
      <div className="stack fields">{duties.map((duty, index) => {
        const change = (patch: Partial<typeof duty>) => setDuties(duties.map(item => item.id === duty.id ? {...item, ...patch} : item))
        return <div className="nested-panel" key={duty.id}><div className="split"><strong>安排 {index + 1}</strong><button type="button" className="btn quiet icon" aria-label={`移除安排 ${index + 1}`} onClick={() => setDuties(duties.filter(item => item.id !== duty.id))}><Trash2 size={17}/></button></div>
          <div className="form-grid"><Field label="日期"><input type="date" required value={duty.date} onChange={event => change({date: event.target.value})}/></Field><Field label="值日区域"><input required value={duty.area} onChange={event => change({area: event.target.value})}/></Field><Field label="负责成员（姓名以顿号分隔）" wide><input value={duty.nameText} onChange={event => change({nameText: event.target.value})}/></Field></div>
        </div>
      })}<button type="button" className="btn" onClick={() => setDuties([...duties, {id: createId(), date: dateCN(), area: '', names: [], nameText: ''}])}><Plus size={17}/>添加安排</button></div>
    </AsyncForm>
  </Modal>
}

function MemberEditor({data, member, close, saved}: {data: ClassData; member: Member; close: () => void; saved: () => void}) {
  const [avatars, setAvatars] = useState(member.avatarFileId ? [member.avatarFileId] : [])
  return <Modal title={'成员展示信息 · ' + member.name} close={close}>
    <AsyncForm cancel={close} submit={async form => {
      await api('/class', 'PUT', {version: data.version, members: [{id: member.id, displayName: val(form, 'displayName'), position: val(form, 'position'), avatarFileId: avatars[0] || ''}]})
      saved()
    }}><div className="stack fields">
      <Field label="显示姓名"><input name="displayName" defaultValue={member.name} maxLength={100} required /></Field>
      <Field label="班级分工"><input name="position" defaultValue={member.position} maxLength={100}/></Field>
      <UploadFiles purpose="avatar" entityId={member.id} max={1} label="成员头像" ids={avatars} setIds={setAvatars}/>
    </div></AsyncForm>
  </Modal>
}

export function Accounts({changed}: {changed: () => void}) {
  const users = useQuery<User[]>('/users')
  const [editor, setEditor] = useState<{action: 'new' | 'edit' | 'batch' | 'reset'; user?: User}>()
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const results = users.data?.filter(user => `${user.username} ${user.name} ${roleNames[user.role]}`.toLowerCase().includes(query.trim().toLowerCase()))
  const close = () => setEditor(undefined)
  const saved = (message: string) => {close(); users.reload(); changed(); setNotice(message)}
  return <div className="stack">
    <PageTitle label="管理设置" title="账号与权限" detail="统一创建成员账号，分配班委身份与班费维护权限。" actions={<><button className="btn" onClick={() => setEditor({action: 'batch'})}>批量创建</button><button className="btn primary" onClick={() => setEditor({action: 'new'})}><UserRoundPlus size={18}/>创建账号</button></>}/>
    <Panel title="成员账号" actions={<input type="search" aria-label="搜索账号" placeholder="搜索姓名、用户名或身份" value={query} onChange={event => setQuery(event.target.value)}/>}>
      <Feedback {...users} retry={users.reload}/>
      {notice && <p className="feedback" role="status">{notice}</p>}
      {results && (results.length ? <div className="rows">{results.map(user => <div className="list-row account-row" key={user.id}>
        <span className="avatar">{user.name.slice(0, 1)}</span><span><strong>{user.name}</strong><small>{user.username} · {roleNames[user.role]}</small></span>
        <div className="badge-group row-tail">{user.role === 'admin' ? <Badge tone="good"><ShieldCheck size={15}/>全部管理权限</Badge> : user.role === 'committee' && user.financeManage && <Badge tone="good"><ShieldCheck size={15}/>班费维护</Badge>}<Badge tone={user.active ? 'good' : 'bad'}>{user.active ? '启用' : '停用'}</Badge>{user.mustChangePassword && user.active && <Badge tone="warn">待改密</Badge>}</div>
        <div className="actions"><button className="btn quiet" onClick={() => setEditor({action: 'edit', user})}><Pencil size={16}/>编辑</button><button className="btn quiet" onClick={() => setEditor({action: 'reset', user})}><KeyRound size={16}/>重置密码</button></div>
      </div>)}</div> : <Empty>没有符合条件的账号。</Empty>)}
    </Panel>
    {(editor?.action === 'new' || editor?.action === 'edit') && <AccountEditor user={editor.user} close={close} saved={() => saved('账号已保存。')}/>}
    {editor?.action === 'reset' && editor.user && <ResetPassword user={editor.user} close={close} saved={() => saved('密码已重置。')}/>}
    {editor?.action === 'batch' && <BatchAccounts close={close} saved={count => saved(`已创建 ${count} 个账号。`)}/>}
  </div>
}

function AccountEditor({user, close, saved}: {user?: User; close: () => void; saved: () => void}) {
  const [role, setRole] = useState<Role>(user?.role || 'student')
  return <Modal title={user ? '编辑账号 · ' + user.name : '创建账号'} close={close}>
    <AsyncForm cancel={close} submit={async form => {
      const input = {name: val(form, 'name'), role, financeManage: role === 'committee' && checked(form, 'financeManage')}
      if (user) await api('/users/' + user.id, 'PUT', {...input, active: checked(form, 'active'), version: user.version})
      else await api('/users', 'POST', {...input, username: val(form, 'username'), password: form.get('password')})
      saved()
    }}>
      <div className="form-grid">
        {!user && <Field label="用户名"><input name="username" required maxLength={64} autoComplete="off"/></Field>}
        <Field label="姓名"><input name="name" required maxLength={80} defaultValue={user?.name}/></Field>
        <Field label="身份"><select value={role} onChange={event => setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        {!user && <Field label="初始密码" wide hint="至少 8 位，成员首次登录时需修改。"><input type="password" name="password" required minLength={8} maxLength={128} autoComplete="new-password"/></Field>}
        {user && <label className="check wide"><input type="checkbox" name="active" defaultChecked={user.active}/>启用账号</label>}
        {role === 'committee' && <label className="check wide"><input type="checkbox" name="financeManage" defaultChecked={user?.financeManage}/>授予班费维护权限</label>}
        {role === 'admin' && <p className="muted wide">管理员拥有全部管理权限，包括班费维护，无需单独授权。</p>}
      </div>
    </AsyncForm>
  </Modal>
}

function ResetPassword({user, close, saved}: {user: User; close: () => void; saved: () => void}) {
  return <Modal title={'重置密码 · ' + user.name} close={close}>
    <AsyncForm button="重置密码" cancel={close} submit={async form => {
      await api('/users/' + user.id + '/reset-password', 'POST', {password: form.get('password')})
      saved()
    }}><Field label="临时密码" hint="至少 8 位。重置后该成员需重新登录并更新密码。"><input type="password" name="password" required minLength={8} maxLength={128} autoComplete="new-password"/></Field></AsyncForm>
  </Modal>
}

function BatchAccounts({close, saved}: {close: () => void; saved: (count: number) => void}) {
  const [show, setShow] = useState(false)
  return <Modal title="批量创建账号" close={close} wide>
    <AsyncForm cancel={close} button="批量创建" submit={async form => {
      const roles: Record<string, Role> = {admin: 'admin', committee: 'committee', student: 'student', 管理员: 'admin', 班委: 'committee', 学生: 'student'}
      const users = lines(val(form, 'rows')).map((line, index) => {
        const values = line.split(line.includes('\t') ? '\t' : ',').map(value => value.trim())
        const [username, name, role, password] = values
        if (values.length !== 4 || !username || !name || !Object.hasOwn(roles, role) || !password || password.length < 8) throw new Error(`第 ${index + 1} 行格式不正确。请检查四列、身份和密码长度。`)
        return {username, name, role: roles[role], password}
      })
      if (!users.length) throw new Error('请填写至少一个账号。')
      const result = await api<{count: number}>('/users/batch', 'POST', {users})
      saved(result.count)
    }}>
      <div className="stack fields"><p className="muted">每行四列，依次填写用户名、姓名、身份、初始密码。使用英文逗号或制表符分隔。身份可填管理员、班委或学生。</p>
        <Field label="账号清单"><textarea name="rows" rows={8} required spellCheck={false} className={show ? '' : 'masked'} autoComplete="off"/></Field>
        <label className="check"><input type="checkbox" checked={show} onChange={event => setShow(event.target.checked)}/>显示输入内容</label>
      </div>
    </AsyncForm>
  </Modal>
}
