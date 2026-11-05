import { useEffect, useState, type CSSProperties } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, dateCN, dateLabel, errorMessage, useQuery } from './api'
import { AsyncForm, Badge, Empty, Feedback, Field, Modal, PageTitle, Panel, val } from './ui'
import type { Course, Period, Timetable } from './types'

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
  const [editing, setEditing] = useState<'template' | 'exception' | null>(null)
  const [version, setVersion] = useState(0)
  const day = useQuery<Timetable>('/public/timetable?date=' + date)
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
  }
  const move = (direction: number) => setDate(shiftDate(date, direction * (view === 'day' ? 1 : 7)))
  return <div className="stack">
    <PageTitle label="学习安排" title="课程表" detail="按节次查看课程、教室与临时调课。" actions={manager && day.data && <><button className="btn" onClick={() => setEditing('exception')}><CalendarDays size={17}/>临时调整</button><button className="btn primary" onClick={() => setEditing('template')}><Pencil size={16}/>编辑周课表</button></>}/>
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
      {day.data?.effectiveDate && <p className="muted schedule-foot">当前选择日期使用的模板生效于 {day.data.effectiveDate}。</p>}
    </section>
    {manager && day.data && day.data.exceptions.length > 0 && <Panel title="临时调整记录" detail={dateLabel(date)}>
      <div className="rows">{day.data.exceptions.filter(item => item.date === date).map(item => <ExceptionRow key={item.id} item={item} courses={day.data!.courses} reload={reload} />)}</div>
    </Panel>}
    {editing === 'template' && day.data && <TemplateEditor timetable={day.data} close={() => setEditing(null)} saved={effective => {setDate(effective); setEditing(null); reload()}} />}
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

function TemplateEditor({timetable, close, saved}: {timetable: Timetable; close: () => void; saved: (date: string) => void}) {
  const [periods, setPeriods] = useState(timetable.periods)
  const [courses, setCourses] = useState(timetable.courses)
  return <Modal title="编辑固定周课表" close={close} wide>
    <AsyncForm cancel={close} submit={async data => {
      const effectiveDate = val(data, 'effectiveDate')
      const target = await api<Timetable>('/public/timetable?date=' + effectiveDate)
      const replacing = target.version > 0 && target.effectiveDate === effectiveDate
      if (replacing && effectiveDate !== timetable.effectiveDate) throw new Error('这一天已有生效模板。请先切换到该日期再编辑。')
      const version = replacing ? timetable.version : 0
      await api('/timetable', 'PUT', {effectiveDate, periods, courses, version})
      saved(effectiveDate)
    }}>
      <div className="stack fields">
        <Field label="模板生效日期" hint="从该日期起按新模板循环，日期例外单独设置。"><input type="date" name="effectiveDate" required min={dateCN()} defaultValue={timetable.date >= dateCN() ? timetable.date : dateCN()}/></Field>
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
          <button type="button" className="btn" disabled={!periods.length} onClick={() => setCourses([...courses, {id: crypto.randomUUID(), name: '', teacher: '', room: '', color: colors[0].value, day: dayOfWeek(timetable.date), startPeriod: periods[0].id, endPeriod: periods[0].id, notes: ''}])}><Plus size={17}/>添加课程</button>
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
      await api('/timetable/exceptions', 'POST', {date: timetable.date, courseId: course.id, action, ...(action === 'replace' ? {course} : {})})
      saved()
    }}><div className="stack fields">
      <p className="muted">调整日期 {dateLabel(timetable.date)}。可先在课表上选择其他日期。</p>
      <Field label="原课程"><select value={course.id} onChange={event => setCourse(selectable.find(item => item.id === event.target.value))}>{selectable.map(item => <option key={item.id} value={item.id}>{item.name}（第 {item.startPeriod} 节）</option>)}</select></Field>
      <Field label="调整方式"><select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="cancel">停课</option><option value="replace">更改课程或节次</option></select></Field>
      {action === 'replace' && <CourseFields course={course} periods={timetable.periods} change={setCourse} showDay={false}/>}
    </div></AsyncForm> : <Empty>所选日期没有可以调整的固定课程。</Empty>}
  </Modal>
}

function ExceptionRow({item, courses, reload}: {item: Timetable['exceptions'][number]; courses: Course[]; reload: () => void}) {
  const [removing, setRemoving] = useState(false)
  return <div className="list-row"><span><strong>{courses.find(course => course.id === item.courseId)?.name || item.course?.name || '课程'}</strong><small>{item.course?.notes}</small></span><Badge>{item.action === 'cancel' ? '停课' : '临时调课'}</Badge><button className="btn quiet" onClick={() => setRemoving(true)}>移除调整</button>
    {removing && <Modal title="移除临时调整" close={() => setRemoving(false)}><AsyncForm button="移除调整" danger cancel={() => setRemoving(false)} submit={async () => {
      await api('/timetable/exceptions/' + item.id, 'DELETE')
      setRemoving(false)
      reload()
    }}><p>移除此记录后，所选日期将恢复该课程的固定安排。</p></AsyncForm></Modal>}
  </div>
}
