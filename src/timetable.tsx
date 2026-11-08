import { useEffect, useState, type CSSProperties } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, dateCN, dateLabel, errorMessage, useQuery } from './api'
import { createId } from './id'
import { AsyncForm, Badge, Empty, Feedback, Field, Modal, PageTitle, Panel, val } from './ui'
import type { Course, Period, Timetable, TimetableTemplate, TimetableTemplates } from './types'

const weekdays = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
const colors = [
  {value: '#0f766e', light: '#e1f4ef', ink: '#1b665b', label: '青绿'},
  {value: '#2563eb', light: '#e9f1ff', ink: '#2c56a1', label: '蓝色'},
  {value: '#7c3aed', light: '#f2eaff', ink: '#6442a2', label: '紫色'},
  {value: '#b45309', light: '#fdf0db', ink: '#8a500b', label: '琥珀'},
  {value: '#be185d', light: '#fbeaf2', ink: '#9a3c64', label: '莓红'},
]

const dayOfWeek = (date: string) => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1
const shiftDate = (date: string, offset: number) => {
  const day = new Date(date + 'T00:00:00Z')
  day.setUTCDate(day.getUTCDate() + offset)
  return day.toISOString().slice(0, 10)
}

function colorStyle(course: Course): CSSProperties {
  const namedColors: Record<string, number> = {teal: 0, green: 0, blue: 1, violet: 2, purple: 2, amber: 3, orange: 3, rose: 4, pink: 4}
  const theme = colors.find(color => color.value === course.color) || colors[namedColors[course.color] ?? course.name.length % colors.length]
  return {'--lesson-tint': theme.light, '--lesson-ink': theme.ink, '--lesson-edge': theme.value} as CSSProperties
}

function CourseDetails({course}: {course: Course}) {
  return <><strong>{course.name}</strong>{(course.room || course.teacher) && <small>{[course.room, course.teacher].filter(Boolean).join(' · ')}</small>}{course.notes && <small>{course.notes}</small>}</>
}

export function DailyCourses({courses, periods}: {courses: Course[]; periods: Period[]}) {
  if (!courses.length) return <Empty>当天没有课程安排。</Empty>
  return <div className="daily-courses">{[...courses].sort((a,b) => a.startPeriod - b.startPeriod).map(course => {
    const start = periods.find(period => period.id === course.startPeriod)
    const end = periods.find(period => period.id === course.endPeriod)
    return <div className="daily-course" style={colorStyle(course)} key={course.id}>
      <div className="lesson-time"><Clock3 size={15}/>{start && end ? `${start.start}–${end.end}` : `第 ${course.startPeriod} 节`}</div>
      <div className="lesson-description"><CourseDetails course={course}/></div>
      {course.room && <MapPin size={17} className="lesson-pin" aria-hidden="true" />}
    </div>
  })}</div>
}

export function TimetablePage({manager}: {manager: boolean}) {
  const [date, setDate] = useState(dateCN)
  const [view, setView] = useState<'day' | 'week'>(() => matchMedia('(max-width: 760px)').matches ? 'day' : 'week')
  const [editing, setEditing] = useState<'templates' | 'exception' | null>(null)
  const [templateEditor, setTemplateEditor] = useState<{mode: 'current' | 'saved' | 'new'; template?: TimetableTemplate; selectionVersion: number}>()
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState(0)
  const day = useQuery<Timetable>('/public/timetable?date=' + date)
  const templates = useQuery<TimetableTemplates>(manager && editing === 'templates' ? '/timetable/templates' : null)
  const monday = shiftDate(date, 1 - dayOfWeek(date))
  const weekDates = weekdays.map((_, index) => shiftDate(monday, index))
  const [week, setWeek] = useState<{monday: string; version: number; days?: Timetable[]; error?: string}>()
  useEffect(() => {
    if (view !== 'week') return
    let active = true
    Promise.all(weekdays.map((_, index) => api<Timetable>('/public/timetable?date=' + shiftDate(monday, index)))).then(days => {
      if (active) setWeek({monday, days, version})
    }, error => { if (active) setWeek({monday, error: errorMessage(error), version}) })
    return () => {active = false}
  }, [monday, view, version])
  const currentWeek = week?.monday === monday && week.version === version ? week : undefined
  function reload() {
    setVersion(previous => previous + 1)
    day.reload()
    templates.reload()
  }
  const move = (direction: number) => setDate(shiftDate(date, direction * (view === 'day' ? 1 : 7)))
  return <div className="stack">
    <PageTitle label="学习安排" title="课程表" detail="按节次查看当前已应用的周课表与临时调课。" actions={manager && day.data && <><button className="btn" onClick={() => setEditing('exception')}><CalendarDays size={17}/>临时调整</button><button className="btn" onClick={() => setEditing('templates')}>课表模板</button><button className="btn primary" onClick={() => setTemplateEditor({mode: 'current', selectionVersion: day.data!.selectionVersion})}><Pencil size={16}/>编辑当前课表</button></>}/>
    {notice && <p className="feedback" role="status">{notice}</p>}
    <section className="panel timetable-panel">
      <div className="toolbar timetable-toolbar">
        <div className="actions">
          <button className="btn icon" aria-label={view === 'day' ? '上一天' : '上一周'} onClick={() => move(-1)}><ChevronLeft size={20}/></button>
          <button className="btn icon" aria-label={view === 'day' ? '下一天' : '下一周'} onClick={() => move(1)}><ChevronRight size={20}/></button>
          <button className="btn" onClick={() => setDate(dateCN())}>今天</button>
          <input type="date" aria-label="跳转到日期" value={date} onChange={event => {if (event.target.value) setDate(event.target.value)}} />
        </div>
        <div className="segments" aria-label="课表视图"><button aria-pressed={view === 'day'} onClick={() => setView('day')}>当日</button><button aria-pressed={view === 'week'} onClick={() => setView('week')}>整周</button></div>
      </div>
      {view === 'day' ? <><h2 className="schedule-caption">{dateLabel(date)}</h2>
        <Feedback {...day} retry={day.reload}/>
        {day.data && <DailyCourses courses={day.data.today} periods={day.data.periods} />}
      </> : <><h2 className="schedule-caption">{weekDates[0]} — {weekDates[6]}</h2>
        <Feedback loading={!currentWeek} error={currentWeek?.error} retry={reload} />
        {currentWeek?.days && <WeekGrid days={currentWeek.days} selected={date} selectDay={value => {setDate(value); setView('day')}} />}
      </>}
      {day.data?.templateId && <p className="muted schedule-foot">当前课表：{day.data.templateName}，每周固定重复。</p>}
    </section>
    {manager && day.data && day.data.exceptions.length > 0 && <Panel title="临时调整记录" detail={dateLabel(date)}>
      <div className="rows">{day.data.exceptions.filter(item => item.date === date).map(item => <ExceptionRow key={item.id} item={item} timetable={day.data!} reload={reload} />)}</div>
    </Panel>}
    {manager && editing === 'templates' && !templateEditor && <Modal title="课表模板" close={() => setEditing(null)} wide>
      <p className="muted">保存模板不会自动切换课表。管理员或班委点击“应用此模板”后，全班查看同一份周课表；临时调课随所属模板保留。</p>
      <Feedback {...templates} retry={templates.reload}/>
      {templates.data && <div className="stack">
        <button className="btn" onClick={() => setTemplateEditor({mode: 'new', selectionVersion: templates.data!.selectionVersion})}><Plus size={17}/>从当前课表新建模板</button>
        {templates.data.templates.map(template => <article className="nested-panel" key={template.id}>
          <div className="split"><div><h3>{template.name}</h3><p className="muted">{template.courses.length} 门课程 · {template.periods.length} 个节次</p></div>{template.id === templates.data!.activeTemplateId && <Badge tone="good">正在使用</Badge>}</div>
          <div className="actions"><button className="btn" onClick={() => setTemplateEditor({mode: 'saved', template, selectionVersion: templates.data!.selectionVersion})}>编辑模板</button>
            {template.id !== templates.data!.activeTemplateId && <AsyncForm button="应用此模板" submit={async () => {
              await api(`/timetable/templates/${template.id}/apply`, 'POST', {version: template.version, selectionVersion: templates.data!.selectionVersion})
              setEditing(null); setNotice(`已应用“${template.name}”，课表已更新。`); reload()
            }}>{null}</AsyncForm>}</div>
        </article>)}
        {!templates.data.templates.length && <Empty>暂无保存的模板，可先编辑当前课表。</Empty>}
      </div>}
    </Modal>}
    {manager && templateEditor && day.data && <TemplateEditor timetable={day.data} {...templateEditor} close={() => setTemplateEditor(undefined)} saved={() => {
      setNotice(templateEditor.mode === 'current' || templateEditor.template?.id === day.data!.templateId ? '当前课表已保存并立即生效。' : '模板已保存，可在课表模板中选择应用。')
      setTemplateEditor(undefined); reload()
    }} />}
    {editing === 'exception' && day.data && <ExceptionEditor timetable={day.data} close={() => setEditing(null)} saved={() => {setEditing(null); reload()}} />}
  </div>
}

function WeekGrid({days, selected, selectDay}: {days: Timetable[]; selected: string; selectDay: (date: string) => void}) {
  const periods = [...new Map(days.flatMap(day => day.periods).map(period => [period.id, period])).values()].sort((a,b) => a.id - b.id)
  if (!periods.length) return <Empty>这一周暂无已配置的课表。</Empty>
  return <div className="schedule-scroll" tabIndex={0} aria-label="可横向滚动的周课表"><div className="week-grid" style={{gridTemplateRows: `auto repeat(${periods.length}, minmax(82px, auto))`}}>
    <div className="week-heading">节次</div>
    {days.map((day, index) => <button className={'week-heading week-day' + (day.date === selected ? ' selected' : '')} key={day.date} onClick={() => selectDay(day.date)}><strong>{weekdays[index]}</strong><small>{day.date.slice(5).replace('-', '/')}</small></button>)}
    {periods.map((period, index) => <div key={period.id} className="week-period" style={{gridColumn: 1, gridRow: index + 2}}><strong>{period.label}</strong><small>{period.start}–{period.end}</small></div>)}
    {days.flatMap((day, dayIndex) => periods.map((period, periodIndex) => <div aria-hidden="true" className={'week-cell' + (day.date === selected ? ' selected' : '')} key={day.date + ':' + period.id} style={{gridColumn: dayIndex + 2, gridRow: periodIndex + 2}} />))}
    {days.flatMap((day, index) => day.today.map(course => {
      const start = periods.findIndex(period => period.id === course.startPeriod)
      const end = periods.findIndex(period => period.id === course.endPeriod)
      if (start < 0 || end < start) return null
      return <div key={day.date + ':' + course.id} className="week-course" style={{...colorStyle(course), gridColumn: index + 2, gridRow: `${start + 2} / ${end + 3}`}}><CourseDetails course={course}/></div>
    }))}
  </div></div>
}

function CourseFields({course, periods, change, showDay = true}: {course: Course; periods: Period[]; change: (course: Course) => void; showDay?: boolean}) {
  const periodOptions = periods.map(period => <option key={period.id} value={period.id}>{period.label}</option>)
  const patch = (changes: Partial<Course>) => change({...course, ...changes})
  return <div className="form-grid">
    <Field label="课程名称"><input value={course.name} required onChange={event => patch({name: event.target.value})}/></Field>
    {showDay && <Field label="上课日"><select value={course.day} onChange={event => patch({day: Number(event.target.value)})}>{weekdays.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></Field>}
    <Field label="起始节次"><select required value={course.startPeriod} onChange={event => patch({startPeriod: Number(event.target.value)})}><option value="">请选择</option>{periodOptions}</select></Field>
    <Field label="结束节次"><select required value={course.endPeriod} onChange={event => patch({endPeriod: Number(event.target.value)})}><option value="">请选择</option>{periodOptions}</select></Field>
    <Field label="授课教师"><input value={course.teacher} onChange={event => patch({teacher: event.target.value})}/></Field>
    <Field label="教室"><input value={course.room} onChange={event => patch({room: event.target.value})}/></Field>
    <Field label="颜色"><select value={course.color} onChange={event => patch({color: event.target.value})}>
      {!colors.some(color => color.value === course.color) && <option value={course.color}>当前颜色</option>}
      {colors.map(color => <option key={color.value} value={color.value}>{color.label}</option>)}
    </select></Field>
    <Field label="公开备注"><input value={course.notes} onChange={event => patch({notes: event.target.value})}/></Field>
  </div>
}

function TemplateEditor({timetable, template, mode, selectionVersion, close, saved}: {timetable: Timetable; template?: TimetableTemplate; mode: 'current' | 'saved' | 'new'; selectionVersion: number; close: () => void; saved: () => void}) {
  const [periods, setPeriods] = useState(template?.periods ?? timetable.periods)
  const [courses, setCourses] = useState(template?.courses ?? timetable.courses)
  const active = mode === 'current' || template?.id === timetable.templateId
  return <Modal title={mode === 'new' ? '新建备用模板' : active ? '编辑当前课表' : '编辑备用模板'} close={close} wide>
    <AsyncForm cancel={close} button={active ? '保存并生效' : '保存模板'} submit={async data => {
      const body = {name: val(data, 'name'), periods, courses, selectionVersion}
      if (mode === 'new') await api('/timetable/templates', 'POST', body)
      else if (template) await api('/timetable/templates/' + template.id, 'PUT', {...body, version: template.version})
      else await api('/timetable', 'PUT', {...body, templateId: timetable.templateId, version: timetable.version})
      saved()
    }}>
      <div className="stack fields">
        <Field label="课表名称" hint={active ? '保存后立即更新当前周课表。' : '仅保存为备用模板，需在模板列表点击应用后生效。'}><input name="name" required maxLength={100} defaultValue={template?.name ?? (mode === 'new' ? '新周课表' : timetable.templateName || '班级周课表')}/></Field>
        <div className="editor-section"><h3>节次时间</h3>
          {periods.map(period => <div className="period-fields" key={period.id}>
            <Field label="名称"><input value={period.label} required onChange={event => setPeriods(periods.map(item => item.id === period.id ? {...item, label: event.target.value} : item))}/></Field>
            <Field label="开始"><input type="time" value={period.start} required onChange={event => setPeriods(periods.map(item => item.id === period.id ? {...item, start: event.target.value} : item))}/></Field>
            <Field label="结束"><input type="time" value={period.end} required onChange={event => setPeriods(periods.map(item => item.id === period.id ? {...item, end: event.target.value} : item))}/></Field>
            <button className="btn icon" type="button" aria-label={`移除 ${period.label}`} disabled={courses.some(course => period.id === course.startPeriod || period.id === course.endPeriod)} onClick={() => setPeriods(periods.filter(item => item.id !== period.id))}><Trash2 size={17}/></button>
          </div>)}
          <button type="button" className="btn" onClick={() => {
            const id = Math.max(0, ...periods.map(period => period.id)) + 1
            setPeriods([...periods, {id, label: `第 ${id} 节`, start: '', end: ''}])
          }}><Plus size={17}/>添加节次</button>
        </div>
        <div className="editor-section"><h3>固定课程</h3>
          {courses.map((course, index) => <div className="nested-panel" key={course.id}><div className="split"><strong>课程 {index + 1}</strong><button className="btn quiet icon" type="button" aria-label={`移除课程 ${index + 1}`} onClick={() => setCourses(courses.filter(item => item.id !== course.id))}><Trash2 size={17}/></button></div><CourseFields course={course} periods={periods} change={next => setCourses(courses.map(item => item.id === next.id ? next : item))}/></div>)}
          <button type="button" className="btn" disabled={!periods.length} onClick={() => setCourses([...courses, {id: createId(), name: '', teacher: '', room: '', color: colors[0].value, day: dayOfWeek(timetable.date), startPeriod: periods[0].id, endPeriod: periods[0].id, notes: ''}])}><Plus size={17}/>添加课程</button>
        </div>
      </div>
    </AsyncForm>
  </Modal>
}

function ExceptionEditor({timetable, close, saved}: {timetable: Timetable; close: () => void; saved: () => void}) {
  const [action, setAction] = useState<'cancel' | 'replace'>('cancel')
  const selectable = timetable.courses.filter(course => course.day === dayOfWeek(timetable.date))
  const [course, setCourse] = useState<Course | undefined>(selectable[0])
  return <Modal title="新增临时调课" close={close}>
    {course ? <AsyncForm cancel={close} submit={async () => {
      await api('/timetable/exceptions', 'POST', {templateId: timetable.templateId, version: timetable.version, selectionVersion: timetable.selectionVersion, date: timetable.date, courseId: course.id, action, ...(action === 'replace' ? {course} : {})})
      saved()
    }}><div className="stack fields">
      <p className="muted">调整日期 {dateLabel(timetable.date)}。可先在课表上选择其他日期。</p>
      <Field label="原课程"><select value={course.id} onChange={event => setCourse(selectable.find(item => item.id === event.target.value))}>{selectable.map(item => <option key={item.id} value={item.id}>{item.name}（第 {item.startPeriod} 节）</option>)}</select></Field>
      <Field label="调整方式"><select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="cancel">停课</option><option value="replace">更改课程或节次</option></select></Field>
      {action === 'replace' && <CourseFields course={course} periods={timetable.periods} change={setCourse} showDay={false}/>}
    </div></AsyncForm> : <Empty>所选日期没有可以调整的固定课程。</Empty>}
  </Modal>
}

function ExceptionRow({item, timetable, reload}: {item: Timetable['exceptions'][number]; timetable: Timetable; reload: () => void}) {
  const [removing, setRemoving] = useState(false)
  return <div className="list-row"><span><strong>{timetable.courses.find(course => course.id === item.courseId)?.name || item.course?.name || '课程'}</strong><small>{item.course?.notes}</small></span><Badge>{item.action === 'cancel' ? '停课' : '临时调课'}</Badge><button className="btn quiet" onClick={() => setRemoving(true)}>移除调整</button>
    {removing && <Modal title="移除临时调整" close={() => setRemoving(false)}><AsyncForm button="移除调整" danger cancel={() => setRemoving(false)} submit={async () => {
      await api('/timetable/exceptions/' + item.id, 'DELETE', {templateId: timetable.templateId, version: timetable.version, selectionVersion: timetable.selectionVersion})
      setRemoving(false)
      reload()
    }}><p>移除此记录后，所选日期将恢复该课程的固定安排。</p></AsyncForm></Modal>}
  </div>
}
