import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BookOpen, ClipboardList, Clock3, History, Pencil, Plus, UsersRound } from 'lucide-react'
import { api, datetimeInput, datetimeISO, timestamp, useQuery } from './api'
import { createId } from './id'
import { AsyncForm, Badge, checked, Empty, ExportButton, Feedback, Field, FileList, Modal, PageTitle, Panel, UploadFiles, val } from './ui'
import type { ClassData, Field as TaskField, FieldType, Participant, Submission, Task, TaskKind, User } from './types'

const statusNames = {draft: '草稿', published: '已发布', archived: '已归档'}
const fieldNames: Record<FieldType, string> = {text: '短文本', textarea: '长文本', select: '单选', multiselect: '多选', file: '附件'}
const affairCategories = ['活动报名', '信息登记', '材料收集']

export function Tasks({kind, user}: {kind: TaskKind; user: User}) {
  const location = useLocation()
  const navigate = useNavigate()
  const base = '/' + kind
  const id = location.pathname.slice(base.length + 1).split('/')[0]
  const manager = user.role !== 'student'
  const [history, setHistory] = useState(false)
  const [filter, setFilter] = useState('current')
  const [search, setSearch] = useState('')
  const list = useQuery<Task[]>(id ? null : base)
  const detail = useQuery<Task>(id ? base + '/' + id : null)
  const editing = manager && new URLSearchParams(location.search).has(id ? 'edit' : 'create')
  const title = kind === 'homework' ? '作业公告' : '事务办理'
  const Icon = kind === 'homework' ? BookOpen : ClipboardList
  const filtered = list.data?.filter(task => {
    const current = filter === 'current' ? task.status === 'published' : filter === 'all' || task.status === filter
    return current && `${task.title} ${task.course} ${task.description}`.toLowerCase().includes(search.trim().toLowerCase())
  })
  function saved(task: Task) {
    list.reload()
    detail.reload()
    navigate(base + '/' + task.id)
  }
  return <div className="stack">
    {id ? <>
      <Link className="text-link" to={base}><ArrowLeft size={17}/>返回{title}</Link>
      <Feedback {...detail} retry={detail.reload} />
      {detail.data && <TaskDetail key={id} task={detail.data} user={user} base={base} reload={detail.reload} />}
    </> : <>
      <PageTitle label="班级工作台" title={title} detail={kind === 'homework' ? '查看作业要求、截止日期与提交记录。' : '办理报名、信息登记与班级材料收集。'} actions={<>
        {user.role !== 'admin' && <button className="btn" onClick={() => setHistory(true)}><History size={17}/>我的提交历史</button>}
        {manager && <Link className="btn primary" to={base + '?create=1'}><Plus size={17}/>{kind === 'homework' ? '新建作业' : '新建事务'}</Link>}
      </>}/>
      <section className="panel">
        <div className="toolbar"><div className="segments" aria-label="按状态筛选">{[['current', '已发布'], ['archived', '已归档'], ...(manager ? [['draft', '草稿'], ['all', '全部']] : [])].map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
          <input type="search" aria-label={'搜索' + title} placeholder="按标题或关键词搜索" value={search} onChange={event => setSearch(event.target.value)}/>
        </div>
        <Feedback {...list} retry={list.reload} />
        {filtered && (filtered.length ? <div className="rows">{filtered.map(task => <Link className="list-row" key={task.id} to={base + '/' + task.id}><span className={'row-icon ' + (kind === 'homework' ? 'violet' : 'sky')}><Icon size={19}/></span>
          <span><strong>{task.title}</strong><small>{[task.course, task.deadline ? '截止 ' + timestamp(task.deadline) : '无截止时间'].filter(Boolean).join(' · ')}</small></span>
          <span className="row-tail badge-group">{manager && task.requiresSubmission && <Badge>{task.submittedCount}/{task.participantCount} 已完成</Badge>}<TaskStatus task={task} manager={manager}/></span><ArrowRight size={17} className="list-arrow"/>
        </Link>)}</div> : <Empty>{search ? '没有符合搜索条件的事项。' : '当前筛选下没有事项。'}</Empty>)}
      </section>
    </>}
    {editing && (!id || detail.data) && <TaskEditor task={detail.data} base={base} kind={kind} close={() => navigate(location.pathname)} saved={saved} />}
    {history && <OwnHistory close={() => setHistory(false)} />}
  </div>
}

function TaskStatus({task, manager}: {task: Task; manager: boolean}) {
  if (task.status !== 'published' || manager) return <Badge tone={task.status === 'published' ? 'good' : ''}>{statusNames[task.status]}</Badge>
  if (!task.requiresSubmission) return <Badge>仅公告</Badge>
  if (task.myParticipantStatus === 'excused') return <Badge>免交</Badge>
  if (task.mySubmission) return <Badge tone={task.mySubmission.late ? 'warn' : 'good'}>{task.mySubmission.late ? '已补交' : '已提交'}</Badge>
  if (task.myParticipantStatus !== 'required') return <Badge>不在参与名单</Badge>
  const overdue = task.deadline && Date.parse(task.deadline) < Date.now()
  return <Badge tone="warn">{overdue ? (task.allowLate ? '可补交' : '已截止') : '待提交'}</Badge>
}

function TaskDetail({task, user, base, reload}: {task: Task; user: User; base: string; reload: () => void}) {
  const manager = user.role !== 'student'
  const path = base + '/' + task.id
  const [view, setView] = useState<'participants' | 'submissions' | 'submit' | 'history' | 'lifecycle'>()
  const [lifecycle, setLifecycle] = useState<Task['status']>('published')
  const [notice, setNotice] = useState('')
  const overdue = task.deadline && Date.parse(task.deadline) < Date.now()
  const canSubmit = user.role !== 'admin' && task.status === 'published' && task.requiresSubmission && task.myParticipantStatus === 'required' && (!overdue || task.allowLate)
  const close = () => setView(undefined)
  function saved(message: string) {
    setNotice(message)
    close()
    reload()
  }
  const lifecycleButton = (status: Task['status'], label: string) => <button className="btn" onClick={() => {setLifecycle(status); setView('lifecycle')}}>{label}</button>
  return <>
    <PageTitle label={task.course || (task.kind === 'homework' ? '作业公告' : '班级事务')} title={task.title} detail={`${task.authorName} · 更新于 ${timestamp(task.updatedAt)}`} actions={manager && <>
      <Link className="btn" to={path + '?edit=1'}><Pencil size={16}/>编辑</Link>
      {task.status !== 'published' && lifecycleButton('published', task.status === 'archived' ? '恢复发布' : '发布')}
      {task.status === 'published' && lifecycleButton('draft', '撤回')}
      {task.status === 'published' && lifecycleButton('archived', '归档')}
    </>} />
    {notice && <p className="feedback" role="status">{notice}</p>}
    <Panel title="事项说明">
      <div className="badge-group"><TaskStatus task={task} manager={manager}/><Badge><Clock3 size={15}/>{task.deadline ? '截止 ' + timestamp(task.deadline) : '无截止时间'}</Badge>{task.allowLate && <Badge>允许补交</Badge>}{task.attachmentRequired && <Badge>提交附件必填</Badge>}</div>
      <p className="prose">{task.description || '暂无附加说明。'}</p>
      <FileList ids={task.attachments} />
    </Panel>
    {user.role !== 'admin' && task.requiresSubmission && <Panel title="我的提交" actions={canSubmit && <button className="btn primary" onClick={() => setView('submit')}>{task.mySubmission ? '更新提交' : '填写并提交'}</button>}>
      {task.mySubmission ? <SubmissionCard submission={task.mySubmission} fields={task.fields} /> : <p className="muted">{task.myParticipantStatus === 'excused' ? '你已免交此事项。' : task.myParticipantStatus === 'required' ? '还没有提交记录。' : '你不在当前参与名单中。'}</p>}
      {task.mySubmission && <button className="btn quiet" onClick={() => setView('history')}><History size={17}/>我的历史</button>}
    </Panel>}
    {manager && task.requiresSubmission && <Panel title="办理进度" detail={`已完成 ${task.submittedCount} / ${task.participantCount} 人`}>
      <progress max={Math.max(1, task.participantCount)} value={task.submittedCount} aria-label="提交完成进度" />
      <div className="actions"><button className="btn" onClick={() => setView('participants')}><UsersRound size={17}/>参与名单</button>
        <button className="btn" onClick={() => setView('submissions')}>查看提交</button><ExportButton path={path + '/export'}/><ExportButton path={path + '/export-files'} label="打包提交附件" body={{}}/></div>
    </Panel>}
    {view === 'submit' && <SubmissionEditor task={task} path={path} close={close} saved={() => saved('提交已保存。')} />}
    {view === 'participants' && <ParticipantEditor task={task} path={path} close={close} saved={() => saved('参与名单已更新。')} />}
    {view === 'submissions' && <TaskSubmissions task={task} path={path} close={close} />}
    {view === 'history' && <OwnHistory taskId={task.id} close={close} />}
    {view === 'lifecycle' && <Modal title={lifecycle === 'draft' ? '撤回发布' : statusNames[lifecycle]} close={close}>
      <AsyncForm cancel={close} button="确认" submit={async () => {await api(path, 'PUT', {status: lifecycle, version: task.version}); saved('事项状态已更新。')}}>
        <p>{lifecycle === 'published' ? '发布后，班级成员可查看事项及要求。' : lifecycle === 'archived' ? '归档后，成员可查阅此事项及历史提交。' : '撤回后，事项会移至草稿，历史提交会保留。'}</p>
      </AsyncForm>
    </Modal>}
  </>
}

function TaskEditor({task, kind, base, close, saved}: {task?: Task; kind: TaskKind; base: string; close: () => void; saved: (task: Task) => void}) {
  const [fields, setFields] = useState<TaskField[]>(task?.fields || [])
  const [requires, setRequires] = useState(task?.requiresSubmission ?? true)
  const [attachments, setAttachments] = useState(task?.attachments || [])
  const [options, setOptions] = useState(() => Object.fromEntries((task?.fields || []).map(field => [field.id, field.options?.join('\n') || ''])))
  const [status, setStatus] = useState(task?.status || 'draft')
  const previous = useQuery<Submission[]>(task && kind === 'affairs' ? base + '/' + task.id + '/submissions?history=1' : null)
  const locked = !!task && kind === 'affairs' && (!previous.data || previous.data.length > 0)
  return <Modal title={task ? '编辑事项' : kind === 'homework' ? '新建作业' : '新建事务'} close={close} wide>
    <AsyncForm cancel={close} button={status === 'draft' ? '保存草稿' : '保存事项'} submit={async data => {
      const enteredDeadline = val(data, 'deadline')
      const deadline = task && datetimeInput(task.deadline) === enteredDeadline ? task.deadline : datetimeISO(enteredDeadline)
      const body = {title: val(data, 'title'), course: val(data, 'course'), description: val(data, 'description'), deadline, allowLate: checked(data, 'allowLate'), requiresSubmission: requires, attachmentRequired: kind === 'homework' && requires && checked(data, 'attachmentRequired'), status, attachments,
        fields: kind === 'affairs' ? fields.map(field => {
          if (locked && task?.fields.some(previous => previous.id === field.id)) return field
          const selectable = field.type === 'select' || field.type === 'multiselect'
          return {...field, options: selectable ? options[field.id]?.split('\n').map(option => option.trim()).filter(Boolean) || [] : undefined}
        }) : []}
      const result = task ? await api<Task>(base + '/' + task.id, 'PUT', {...body, version: task.version}) : await api<Task>(base, 'POST', body)
      saved(result)
    }}>
      <div className="form-grid">
        <Field label="标题" wide><input name="title" required maxLength={160} defaultValue={task?.title}/></Field>
        {kind === 'homework' ? <Field label="课程"><input name="course" maxLength={80} defaultValue={task?.course} /></Field> : <Field label="事务类别"><select name="course" defaultValue={task?.course || affairCategories[0]}>{task?.course && !affairCategories.includes(task.course) && <option>{task.course}</option>}{affairCategories.map(category => <option key={category}>{category}</option>)}</select></Field>}
        <Field label="状态"><select value={status} onChange={event => setStatus(event.target.value as Task['status'])}>{Object.entries(statusNames).filter(([key]) => task || key !== 'archived').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        <Field label="要求或说明" wide><textarea name="description" rows={5} defaultValue={task?.description}/></Field>
        <Field label="截止时间（北京时间）" hint="留空表示无截止时间。"><input type="datetime-local" name="deadline" defaultValue={datetimeInput(task?.deadline)} /></Field>
        <div className="checks"><label><input type="checkbox" checked={requires} onChange={event => setRequires(event.target.checked)}/>需要提交</label>
          {requires && <label><input type="checkbox" name="allowLate" defaultChecked={task?.allowLate}/>允许补交</label>}
          {kind === 'homework' && requires && <label><input type="checkbox" name="attachmentRequired" defaultChecked={task?.attachmentRequired}/>提交附件必填</label>}
        </div>
        <UploadFiles ids={attachments} setIds={setAttachments} purpose="task-attachment" entityId={task?.id} label="公告附件" />
        {kind === 'affairs' && requires && <section className="wide editor-section">
          <h3>提交表单</h3>
          <Feedback {...previous} retry={previous.reload}/>
          {locked && previous.data && <p className="muted">已有提交记录，可新增选填字段。</p>}
          {fields.map((field, index) => {
            const existing = locked && task?.fields.some(item => item.id === field.id)
            const patch = (changes: Partial<TaskField>) => setFields(fields.map(item => item.id === field.id ? {...item, ...changes} : item))
            return <div className="nested-panel" key={field.id}><div className="split"><strong>字段 {index + 1}</strong>{!existing && <button type="button" className="btn quiet" onClick={() => setFields(fields.filter(item => item.id !== field.id))}>移除字段</button>}</div>
              <div className="form-grid"><Field label="字段名称"><input value={field.label} required maxLength={120} readOnly={existing} onChange={event => patch({label: event.target.value})}/></Field>
                <Field label="字段类型"><select value={field.type} disabled={existing} onChange={event => patch({type: event.target.value as FieldType})}>{Object.entries(fieldNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
                {(field.type === 'select' || field.type === 'multiselect') && <Field label="选项（每行一项）" wide><textarea value={options[field.id] || ''} required readOnly={existing} rows={3} onChange={event => setOptions({...options, [field.id]: event.target.value})}/></Field>}
                <label className="check"><input type="checkbox" checked={field.required} disabled={!!existing || locked} onChange={event => patch({required: event.target.checked})}/>必填</label>
              </div>
            </div>
          })}
          <button className="btn" type="button" onClick={() => setFields([...fields, {id: createId(), label: '', type: 'text', required: false}])}><Plus size={17}/>添加表单字段</button>
        </section>}
      </div>
    </AsyncForm>
  </Modal>
}

function attachmentAnswer(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' && value ? [value] : []
}

function SubmissionEditor({task, path, close, saved}: {task: Task; path: string; close: () => void; saved: () => void}) {
  const previous = task.mySubmission
  const fieldFiles = new Set(task.fields.filter(field => field.type === 'file').flatMap(field => attachmentAnswer(previous?.answers[field.id])))
  const [attachments, setAttachments] = useState((previous?.attachments || []).filter(id => !fieldFiles.has(id)))
  const [fileAnswers, setFileAnswers] = useState<Record<string, string[]>>(() => Object.fromEntries(task.fields.filter(field => field.type === 'file').map(field => [field.id, attachmentAnswer(previous?.answers[field.id])])))
  return <Modal title={previous ? '更新我的提交' : '填写并提交'} close={close}>
    <AsyncForm cancel={close} button="确认提交" submit={async data => {
      if (task.attachmentRequired && !attachments.length) throw new Error('请先上传必填附件。')
      const answers = Object.fromEntries(task.fields.map(field => [field.id, field.type === 'file' ? fileAnswers[field.id] || [] : field.type === 'multiselect' ? data.getAll(field.id) : val(data, field.id)]))
      await api(path + '/submissions', 'POST', {text: val(data, 'submissionText'), answers, attachments})
      saved()
    }}>
      <div className="stack fields">
        {task.fields.map(field => {
          const label = field.label + (field.required ? '（必填）' : '')
          const value = previous?.answers[field.id]
          if (field.type === 'file') return <UploadFiles key={field.id} purpose="submission" entityId={task.id} label={field.label} required={field.required} ids={fileAnswers[field.id] || []} setIds={ids => setFileAnswers(current => ({...current, [field.id]: ids}))}/>
          if (field.type === 'multiselect') return <div className="nested-panel" role="group" aria-label={label} key={field.id}><strong>{label}</strong><div className="checks">{field.options?.map(option => <label key={option}><input type="checkbox" name={field.id} value={option} defaultChecked={Array.isArray(value) && value.includes(option)}/>{option}</label>)}</div></div>
          return <Field label={label} key={field.id}>{field.type === 'select' ? <select name={field.id} required={field.required} defaultValue={String(value || '')}><option value="">请选择</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'textarea' ? <textarea name={field.id} rows={4} required={field.required} defaultValue={String(value || '')}/> : <input name={field.id} required={field.required} defaultValue={String(value || '')}/>}</Field>
        })}
        <Field label={task.kind === 'homework' ? '提交说明' : '补充说明'}><textarea name="submissionText" rows={4} defaultValue={previous?.text}/></Field>
        {(task.kind === 'homework' || attachments.length > 0 || task.fields.length === 0) && <UploadFiles purpose="submission" entityId={task.id} ids={attachments} setIds={setAttachments} label="提交附件" required={task.attachmentRequired}/>}
      </div>
    </AsyncForm>
  </Modal>
}

function ParticipantEditor({task, path, close, saved}: {task: Task; path: string; close: () => void; saved: () => void}) {
  const roster = useQuery<ClassData>('/class')
  const participants = useQuery<Participant[]>(path + '/participants')
  const members = roster.data?.members.filter(member => member.role !== 'admin')
  return <Modal title="参与名单与进度" close={close}>
    <Feedback {...roster} retry={roster.reload}/><Feedback {...participants} retry={participants.reload}/>
    {members && participants.data && <AsyncForm cancel={close} button="更新名单" submit={async data => {
      await api(path + '/participants', 'PUT', {version: task.version, userIds: data.getAll('userId')})
      saved()
    }}>
      <p className="muted">勾选需要提交的成员。取消勾选会将成员标为免交，并保留历史记录。</p>
      <div className="rows">{members.map(member => {
        const participant = participants.data?.find(item => item.userId === member.id)
        return <label className="list-row" key={member.id}><input type="checkbox" name="userId" value={member.id} defaultChecked={participant?.status === 'required'}/><strong>{member.displayName || member.name}</strong><span className="row-tail"><Badge tone={participant?.submitted ? 'good' : ''}>{participant?.status === 'excused' ? '免交' : participant?.submitted ? '已提交' : participant ? '未提交' : '未加入'}</Badge></span></label>
      })}
      {participants.data.filter(item => !members.some(member => member.id === item.userId)).map(item => <div key={item.userId} className="list-row"><strong>{item.name}</strong><Badge>{item.submitted ? '已提交 · 历史成员' : '免交 · 历史成员'}</Badge></div>)}</div>
      {!members.length && <Empty>当前没有在册成员。</Empty>}
    </AsyncForm>}
  </Modal>
}

type HistoryItem = Submission & {taskTitle: string; fields?: TaskField[]; schema?: TaskField[]}

function SubmissionCard({submission, fields = []}: {submission: Submission; fields?: TaskField[]}) {
  return <article className="nested-panel"><div className="split"><strong>{submission.name || '我的提交'}</strong><div className="badge-group"><Badge>第 {submission.version} 版</Badge>{submission.late && <Badge tone="warn">补交</Badge>}</div></div>
    <p className="muted">{timestamp(submission.createdAt)}</p>
    {submission.text && <p className="prose">{submission.text}</p>}
    {fields.length > 0 && <dl className="answers">{fields.filter(field => field.type !== 'file' && submission.answers[field.id] != null).map(field => <div key={field.id}><dt>{field.label}</dt><dd>{Array.isArray(submission.answers[field.id]) ? (submission.answers[field.id] as string[]).join('、') : String(submission.answers[field.id])}</dd></div>)}</dl>}
    <FileList ids={submission.attachments}/>
  </article>
}

function TaskSubmissions({task, path, close}: {task: Task; path: string; close: () => void}) {
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const submissions = useQuery<HistoryItem[]>(path + '/submissions' + (all ? '?history=1' : ''))
  const downloadable = selected.filter(id => submissions.data?.some(submission => submission.userId === id && submission.attachments.length))
  return <Modal title="成员提交记录" close={close} wide>
    <div className="stack"><div className="split">
      <label className="check"><input type="checkbox" checked={all} onChange={event => {setAll(event.target.checked); setSelected([])}}/>包含历史版本</label>
      {!all && downloadable.length > 0 && <ExportButton path={path + '/export-files'} label={`打包所选 ${downloadable.length} 人的附件`} body={{userIds: downloadable}}/>}
    </div>
      <Feedback {...submissions} retry={submissions.reload}/>
      {submissions.data && (submissions.data.length ? submissions.data.map(submission => <div key={submission.id}>
        {!all && submission.attachments.length > 0 && <label className="check"><input type="checkbox" checked={selected.includes(submission.userId)} onChange={event => {
          setSelected(current => event.target.checked ? [...current, submission.userId] : current.filter(id => id !== submission.userId))
        }}/>选择 {submission.name} 的附件</label>}
        <SubmissionCard submission={submission} fields={submission.fields || submission.schema || task.fields}/>
      </div>) : <Empty>暂无成员提交。</Empty>)}
    </div>
  </Modal>
}

function OwnHistory({taskId, close}: {taskId?: string; close: () => void}) {
  const history = useQuery<HistoryItem[]>('/submissions/history')
  const records = history.data?.filter(item => !taskId || item.taskId === taskId)
  return <Modal title="我的提交历史" close={close} wide><div className="stack">
    <Feedback {...history} retry={history.reload}/>
    {records && (records.length ? records.map(item => <div className="history-item" key={item.id}><h3>{item.taskTitle}</h3><SubmissionCard submission={item} fields={item.fields || item.schema}/></div>) : <Empty>还没有提交过作业或事务。</Empty>)}
  </div></Modal>
}
