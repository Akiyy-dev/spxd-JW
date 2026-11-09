import {useState} from 'react'
import {Pencil, Plus, RotateCw, Trash2} from 'lucide-react'
import {DUTY_LIMITS, WEEKDAYS, type Duty, type DutiesData, type Weekday} from '../shared/duties'
import {can} from '../shared/permissions'
import {api, ApiError, useQuery} from './api'
import {createId} from './id'
import {AsyncForm, Empty, Feedback, Field, Modal, PageTitle, Panel} from './ui'
import type {User} from './types'
import './duties.css'

type DutyDraft = Omit<Duty, 'names'> & {names: string}
const newDraft = (weekday: Weekday): DutyDraft => ({id: createId(), weekday, area: '', names: ''})

export function serializeDutyDrafts(rows: DutyDraft[]): Duty[] {
  if (rows.length > DUTY_LIMITS.rows) throw new Error(`最多可保存 ${DUTY_LIMITS.rows} 条值日安排。`)
  return rows.map((row, index) => {
    const area = row.area.trim()
    const names = row.names.split(/[,，、\n]+/).map(name => name.trim()).filter(Boolean)
    const prefix = `第 ${index + 1} 条安排：`
    if (!area) throw new Error(prefix + '请填写值日区域。')
    if (area.length > DUTY_LIMITS.area) throw new Error(prefix + `区域不能超过 ${DUTY_LIMITS.area} 个字。`)
    if (names.length > DUTY_LIMITS.names) throw new Error(prefix + `最多填写 ${DUTY_LIMITS.names} 个姓名。`)
    if (names.some(name => name.length > DUTY_LIMITS.name)) throw new Error(prefix + `每个姓名不能超过 ${DUTY_LIMITS.name} 个字。`)
    return {...row, area, names}
  })
}

export function DutiesPage({user}: {user: User}) {
  const info = useQuery<DutiesData>('/duties')
  const [editor, setEditor] = useState<{data: DutiesData; initialWeekday?: Weekday}>()
  const [notice, setNotice] = useState('')
  const close = () => setEditor(undefined)
  const reload = () => {setNotice(''); info.reload()}
  const edit = (weekday?: Weekday) => {
    if (info.data && can(user, 'class.duties.edit')) setEditor({data: info.data, initialWeekday: weekday})
  }
  return <div className="stack">
    <DutiesSchedule user={user} data={info.data} edit={edit} reload={reload}/>
    <Feedback {...info} retry={info.reload}/>
    {notice && <p className="feedback" role="status">{notice}</p>}
    {editor && can(user, 'class.duties.edit') && <DutyEditor {...editor} close={close} saved={() => {
      close(); info.reload(); setNotice('每周值日安排已保存。')
    }}/>}
  </div>
}

export function DutiesSchedule({user, data, edit, reload}: {user: User; data?: DutiesData; edit: (weekday?: Weekday) => void; reload?: () => void}) {
  const editable = can(user, 'class.duties.edit')
  return <div className="stack">
    <PageTitle label="班级生活" title="值日安排" detail="按周一至周日安排值日，每周重复执行。同一天可设置多个值日区域。" actions={<>
      {reload && <button type="button" className="btn" onClick={reload}><RotateCw size={16} aria-hidden="true"/>刷新安排</button>}
      {data && editable && <button type="button" className="btn primary" onClick={() => edit()}><Pencil size={16} aria-hidden="true"/>编辑安排</button>}
    </>}/>
    {data && <div className="duties-grid">{WEEKDAYS.map(day => {
      const duties = data.duties.filter(duty => duty.weekday === day.value)
      return <Panel key={day.value} title={day.label} detail={duties.length ? `${duties.length} 个值日区域` : '每周固定安排'} actions={editable && <button type="button" className="btn quiet" aria-label={`为${day.label}添加区域`} disabled={data.duties.length >= DUTY_LIMITS.rows} onClick={() => edit(day.value)}><Plus size={16} aria-hidden="true"/>添加区域</button>}>
        {duties.length ? <ul className="duty-areas">{duties.map(duty => <li key={duty.id} className="duty-area">
          <h3>{duty.area}</h3>
          {duty.names.length ? <ul className="duty-names" aria-label={`${duty.area}值日人员`}>{duty.names.map((name, index) => <li key={index}>{name}</li>)}</ul> : <p className="muted">人员待安排</p>}
        </li>)}</ul> : <Empty>暂无值日安排</Empty>}
      </Panel>
    })}</div>}
  </div>
}

export function DutyEditor({data, initialWeekday, close, saved}: {data: DutiesData; initialWeekday?: Weekday; close: () => void; saved: () => void}) {
  const [rows, setRows] = useState<DutyDraft[]>(() => {
    const existing = data.duties.map(duty => ({...duty, names: duty.names.join('、')}))
    return initialWeekday && existing.length < DUTY_LIMITS.rows ? [...existing, newDraft(initialWeekday)] : existing
  })
  const update = (id: string, changes: Partial<DutyDraft>) => setRows(current => current.map(row => row.id === id ? {...row, ...changes} : row))
  return <Modal title="编辑每周值日安排" close={close} wide>
    <AsyncForm cancel={close} button="保存安排" submit={async () => {
      const duties = serializeDutyDrafts(rows)
      try {
        await api<DutiesData>('/duties', 'PUT', {duties, version: data.version})
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) throw new Error('安排已被其他人更新，你的修改仍保留在此窗口。请关闭窗口并刷新安排，核对后重新编辑。')
        throw error
      }
      saved()
    }}>
      <div className="stack fields">
        <p className="muted">安排每周重复，无需选择具体日期。同一天可添加多条区域安排；姓名可用逗号、中文逗号或顿号分隔。</p>
        {rows.length ? <div className="duty-editor-list">{rows.map((row, index) => <section className="nested-panel duty-editor-row" key={row.id} aria-label={`第 ${index + 1} 条安排`}>
          <div className="split"><h3>安排 {index + 1}</h3><button type="button" className="btn quiet" aria-label={`移除第 ${index + 1} 条安排`} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}><Trash2 size={16} aria-hidden="true"/>移除</button></div>
          <div className="duty-editor-fields">
            <Field label="星期"><select name={`weekday-${row.id}`} value={row.weekday} onChange={event => update(row.id, {weekday: Number(event.target.value) as Weekday})}>{WEEKDAYS.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}</select></Field>
            <Field label="值日区域"><input name={`area-${row.id}`} required maxLength={DUTY_LIMITS.area} value={row.area} placeholder="例如：教室、走廊、黑板" onChange={event => update(row.id, {area: event.target.value})}/></Field>
            <Field label="值日人员" hint={`最多 ${DUTY_LIMITS.names} 人，每个姓名最多 ${DUTY_LIMITS.name} 个字；可留空后补充。`}><input name={`names-${row.id}`} maxLength={DUTY_LIMITS.names * (DUTY_LIMITS.name + 1) - 1} value={row.names} placeholder="例如：张同学、李同学" onChange={event => update(row.id, {names: event.target.value})}/></Field>
          </div>
        </section>)}</div> : <Empty>尚未添加区域。保存空列表将清空所有每周值日安排。</Empty>}
        <div className="split"><button type="button" className="btn" disabled={rows.length >= DUTY_LIMITS.rows} onClick={() => setRows(current => [...current, newDraft(initialWeekday || 1)])}><Plus size={16} aria-hidden="true"/>添加区域</button><small className="muted">{rows.length} / {DUTY_LIMITS.rows} 条安排</small></div>
      </div>
    </AsyncForm>
  </Modal>
}
