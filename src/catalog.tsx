import { useState } from 'react'
import { Archive, ExternalLink, FileText, History, Pencil, Plus, Search, Send, Trash2 } from 'lucide-react'
import { api, dateCN, dateLabel, timestamp, useQuery } from './api'
import { createId } from './id'
import { Avatar } from './avatar'
import { roleNames, type ClassData, type Duty, type Member, type Resource, type User } from './types'
import { AsyncForm, Badge, checked, Empty, Feedback, Field, FileList, Modal, PageTitle, Panel, UploadFiles, val } from './ui'
import {can} from '../shared/permissions'

const lines = (input: string) => input.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
const external = (url: string) => /^https?:\/\//i.test(url)

export function Resources({user}: {user: User}) {
  const list = useQuery<Resource[]>('/resources')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [from, setFrom] = useState('')
  const [status, setStatus] = useState<Resource['status']>('published')
  const [editor, setEditor] = useState<Resource | 'new'>()
  const [history, setHistory] = useState<Resource>()
  const [transition, setTransition] = useState<{item:Resource;status:'published'|'archived'}>()
  const [notice, setNotice] = useState('')
  const visibleStatus=status==='draft'&&!can(user,'resources.drafts.read')||status==='archived'&&!can(user,'resources.archived.read')?'published':status
  const categories = [...new Set(list.data?.filter(item=>canReadResource(user,item)).map(item => item.category) || [])].sort()
  const items = list.data?.filter(item => canReadResource(user,item)&&item.status===visibleStatus
    && (!category || item.category === category) && (!from || dateCN(new Date(item.updatedAt)) >= from)
    && `${item.title} ${item.description} ${item.category}`.toLowerCase().includes(search.trim().toLowerCase()))
  const close = () => setEditor(undefined)
  return <div className="stack">
    <PageTitle label="学习资料" title="资料中心" detail="查找班级文档、学习资料和常用链接。" actions={can(user,'resources.create') && <button className="btn primary" onClick={() => setEditor('new')}><Plus size={18}/>添加资料</button>} />
    <section className="panel">
      <div className="toolbar filter-bar">
        <label className="search-field"><Search size={18}/><input type="search" aria-label="搜索资料" placeholder="搜索资料…" value={search} onChange={event => setSearch(event.target.value)}/></label>
        <select aria-label="按类别筛选" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部类别</option>{categories.map(item => <option key={item}>{item}</option>)}</select>
        <label className="inline-label">更新起始日<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
        {(can(user,'resources.drafts.read')||can(user,'resources.archived.read'))&&<select aria-label="资料状态" value={visibleStatus} onChange={event=>setStatus(event.target.value as Resource['status'])}><option value="published">已发布</option>{can(user,'resources.drafts.read')&&<option value="draft">草稿</option>}{can(user,'resources.archived.read')&&<option value="archived">已归档</option>}</select>}
      </div>
      <Feedback {...list} retry={list.reload}/>
      {notice && <p role="status" className="feedback">{notice}</p>}
      {items && (items.length ? <div className="resource-grid">{items.map(item => <ResourceCard key={item.id} user={user} item={item} edit={()=>setEditor(item)} history={()=>setHistory(item)} changeStatus={next=>setTransition({item,status:next})}/>)}</div> : <Empty>{search || category || from ? '没有符合筛选条件的资料。' : visibleStatus==='archived' ? '暂无归档资料。' : visibleStatus==='draft'?'暂无草稿资料。':'暂无已发布的资料。'}</Empty>)}
    </section>
    {editor && (editor==='new'?can(user,'resources.create'):canEditResource(user,editor)) && <ResourceEditor user={user} item={editor === 'new' ? undefined : editor} close={close} saved={next=> {close(); list.reload();setStatus(next);setNotice(next==='draft'&&!can(user,'resources.drafts.read')?'草稿已保存，可由获授权的成员查看和发布。':'资料已保存。')}}/>}
    {history && can(user,'resources.history.read') && canReadResource(user,history) && <ResourceHistory item={history} close={() => setHistory(undefined)}/>}
    {transition && canReadResource(user,transition.item) && can(user,transition.status==='published'?'resources.publish':'resources.archive') && <ResourceStatus item={transition.item} status={transition.status} close={()=>setTransition(undefined)} saved={()=>{setTransition(undefined);list.reload();setNotice(transition.status==='published'?'资料已发布。':'资料已归档。')}}/>}
  </div>
}

function canReadResource(user:User,item:Resource) {return item.status==='published'||can(user,item.status==='draft'?'resources.drafts.read':'resources.archived.read')}
function canEditResource(user:User,item:Resource) {return canReadResource(user,item)&&can(user,'resources.edit')&&(item.status!=='published'||can(user,'resources.publish'))}

export function ResourceCard({user,item,edit,history,changeStatus}:{user:User;item:Resource;edit:()=>void;history:()=>void;changeStatus:(status:'published'|'archived')=>void}) {
  if(!canReadResource(user,item))return null
  return <article className="resource-card">
    <div className="split"><span className="row-icon sky"><FileText size={20}/></span><div className="badge-group"><Badge>{item.category}</Badge>{item.pinned&&<Badge tone="good">置顶</Badge>}{item.status==='draft'&&<Badge tone="warn">草稿</Badge>}{item.status==='archived'&&<Badge>已归档</Badge>}</div></div>
    <h3>{item.title}</h3><p className="muted">{timestamp(item.updatedAt)}{item.authorName&&' · '+item.authorName}</p>
    {item.description&&<p className="prose">{item.description}</p>}<FileList ids={item.attachments}/>
    <div className="actions">
      {external(item.url)&&<a className="btn" href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>打开外部链接</a>}
      {canEditResource(user,item)&&<button className="btn quiet" onClick={edit}><Pencil size={16}/>编辑</button>}
      {item.status!=='published'&&can(user,'resources.publish')&&<button className="btn quiet" onClick={()=>changeStatus('published')}><Send size={16}/>{item.status==='archived'?'恢复发布':'发布'}</button>}
      {item.status!=='archived'&&can(user,'resources.archive')&&<button className="btn quiet" onClick={()=>changeStatus('archived')}><Archive size={16}/>归档</button>}
      {can(user,'resources.history.read')&&<button className="btn quiet" onClick={history}><History size={16}/>历史版本</button>}
    </div>
  </article>
}

function ResourceStatus({item,status,close,saved}:{item:Resource;status:'published'|'archived';close:()=>void;saved:()=>void}) {
  const label=status==='published'?(item.status==='archived'?'恢复发布':'发布'):'归档'
  return <Modal title={`${label}资料`} close={close}><AsyncForm cancel={close} button={label} submit={async()=>{
    await api('/resources/'+item.id,'PUT',{version:item.version,changes:{status}});saved()
  }}><p>确认{label}「{item.title}」？{status==='published'?'发布后班级成员可以查看。':'归档后将从已发布列表中移除。'}</p></AsyncForm></Modal>
}

function ResourceEditor({user,item, close, saved}: {user:User;item?: Resource; close: () => void; saved: (status:Resource['status']) => void}) {
  const [attachments, setAttachments] = useState(item?.attachments || [])
  return <Modal title={item ? '编辑资料' : '添加资料'} close={close}>
    <AsyncForm cancel={close} submit={async data => {
      const url = val(data, 'url')
      if (url && !external(url)) throw new Error('请输入以 https:// 或 http:// 开头的链接。')
      const status=item?.status??(can(user,'resources.publish')&&val(data,'status')==='published'?'published':'draft')
      const changes = {title: val(data, 'title'), category: val(data, 'category'), url, description: val(data, 'description'), pinned: checked(data, 'pinned'), attachments}
      if (item) await api('/resources/' + item.id, 'PUT', {changes, version: item.version})
      else await api('/resources', 'POST', {...changes,status})
      saved(status)
    }}>
      <div className="form-grid">
        <Field label="资料标题" wide><input name="title" required maxLength={150} defaultValue={item?.title}/></Field>
        <Field label="类别"><input name="category" required maxLength={50} defaultValue={item?.category || '学习资料'}/></Field>
        {!item&&can(user,'resources.publish')?<Field label="保存方式"><select name="status" defaultValue="draft"><option value="draft">保存草稿</option><option value="published">立即发布</option></select></Field>:<p className="muted">{item?`当前状态：${item.status==='published'?'已发布':item.status==='draft'?'草稿':'已归档'}`:'资料将保存为草稿。'}</p>}
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


export function ClassPage({user, changed}: {user:User; changed: () => void}) {
  const info = useQuery<ClassData>('/class')
  const [editor, setEditor] = useState<'settings' | 'duties' | Member>()
  const [notice, setNotice] = useState('')
  const data = info.data
  const close = () => setEditor(undefined)
  const saved = () => {close(); info.reload(); changed(); setNotice('班级信息已更新。')}
  const committees = data?.members.filter(member => member.role === 'committee')
  return <div className="stack">
    <PageTitle label="班级生活" title="班级信息" detail="查阅班级简介、班委分工、成员信息和值日安排。" actions={can(user,'class.settings.edit') && data && <button className="btn primary" onClick={() => setEditor('settings')}><Pencil size={16}/>编辑班级设置</button>}/>
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
          {committees?.length ? <div className="rows">{committees.map(member => <div key={member.id} className="list-row"><Avatar id={member.avatarFileId} name={member.name} className="member-avatar"/><span><strong>{member.name}</strong><small>{member.position || '班委'}</small></span><MemberEditButton user={user} member={member} edit={()=>setEditor(member)}/></div>)}</div> : <Empty>暂无班委分工记录。</Empty>}
        </Panel>
        <Panel title="值日安排" detail="按日期查看区域与负责成员" actions={can(user,'class.duties.edit') && <button className="btn quiet" onClick={() => setEditor('duties')}>编辑安排</button>}>
          {data.duties.length ? <div className="rows">{[...data.duties].sort((a,b) => a.date.localeCompare(b.date)).map(duty => <div className="list-row" key={duty.id}><span><strong>{duty.area}</strong><small>{dateLabel(duty.date)} · {duty.names.join('、') || '待分配'}</small></span></div>)}</div> : <Empty>暂无值日安排。</Empty>}
        </Panel>
      </div>
      <Panel title="班级成员" detail={`在册成员 ${data.members.length} 人`}>
        {data.members.length ? <div className="member-grid">{data.members.map(member => <div className="member-card" key={member.id}><Avatar id={member.avatarFileId} name={member.name} className="member-avatar"/><div><strong>{member.name}</strong><small>{member.position || roleNames[member.role]}</small></div><MemberEditButton user={user} member={member} edit={()=>setEditor(member)} compact/></div>)}</div> : <Empty>暂无成员信息。</Empty>}
      </Panel>
    </>}
    {data && editor === 'settings' && can(user,'class.settings.edit') && <ClassSettings data={data} close={close} saved={saved}/>}
    {data && editor === 'duties' && can(user,'class.duties.edit') && <DutyEditor data={data} close={close} saved={saved}/>}
    {data && editor && typeof editor !== 'string' && canEditMember(user,editor) && <MemberEditor data={data} member={editor} close={close} saved={saved}/>}
  </div>
}

function canEditMember(user:User,member:Member) {return can(user,'class.members.edit')&&(user.role==='super_admin'||member.role==='student'||member.role==='committee')}
export function MemberEditButton({user,member,edit,compact=false}:{user:User;member:Member;edit:()=>void;compact?:boolean}) {
  return canEditMember(user,member)?<button aria-label={`编辑 ${member.name}`} className={'btn quiet row-tail'+(compact?' icon':'')} onClick={edit}>{compact?<Pencil size={16}/>:'编辑'}</button>:null
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
