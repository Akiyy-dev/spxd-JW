import type {FastifyInstance} from 'fastify';
import type {Store} from './db.ts';
import {z} from 'zod';
import {conflict,dateSchema,HttpError,json,now,parse,requirePermission,shanghaiDate,uid} from './common.ts';
import {defaultConfig} from './catalog.ts';

const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const periodSchema=z.object({id:z.number().int().min(1).max(30),label:z.string().min(1).max(20),start:time,end:time});
const courseSchema=z.object({id:z.string().min(1).max(100),name:z.string().trim().min(1).max(100),teacher:z.string().max(100).default(''),room:z.string().max(100).default(''),day:z.number().int().min(1).max(7),startPeriod:z.number().int().positive(),endPeriod:z.number().int().positive(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),notes:z.string().max(500).default('')});
export type Course=z.infer<typeof courseSchema>;
type Period=z.infer<typeof periodSchema>;
type TemplateRow={id:string;effective_date:string|null;data:string;version:number;updated_at:string};
type Selection={templateId:string|null;version:number};
const selectionSchema=z.object({selectionVersion:z.number().int().min(0)});
const guardSchema=selectionSchema.extend({templateId:z.string().min(1).nullable(),version:z.number().int().min(0)});
const templateSchema=selectionSchema.extend({name:z.string().trim().min(1).max(100),periods:z.array(periodSchema).min(1).max(30),courses:z.array(courseSchema).max(200)});
const editSchema=templateSchema.extend({version:z.number().int().min(1)});
export const defaultPeriods=[{id:1,label:'第1节',start:'08:00',end:'08:45'},{id:2,label:'第2节',start:'08:55',end:'09:40'},{id:3,label:'第3节',start:'10:00',end:'10:45'},{id:4,label:'第4节',start:'10:55',end:'11:40'},{id:5,label:'第5节',start:'14:00',end:'14:45'},{id:6,label:'第6节',start:'14:55',end:'15:40'},{id:7,label:'第7节',start:'16:00',end:'16:45'},{id:8,label:'第8节',start:'16:55',end:'17:40'}];

function selection(db:Store):Selection {
  return db.transaction(()=>{
    const existing=db.setting<Selection|null>('timetable.selection',null);
    if(existing)return existing;
    // Freeze the legacy choice once, using today rather than the date being viewed.
    const active=db.get<TemplateRow>('SELECT * FROM timetable_templates WHERE effective_date<=? ORDER BY effective_date DESC LIMIT 1',shanghaiDate());
    const state={templateId:active?.id??null,version:0};
    db.setSetting('timetable.selection',state);return state;
  });
}
function getTemplate(db:Store,id:string) {
  const row=db.get<TemplateRow>('SELECT * FROM timetable_templates WHERE id=?',id);
  if(!row)throw new HttpError(404,'课表模板不存在');
  return row;
}
function describeTemplate(row:TemplateRow) {
  const data=json<{name?:string;periods:Period[];courses:Course[]}>(row.data,{periods:defaultPeriods,courses:[]});
  return {id:row.id,name:data.name??`课表 ${row.effective_date??''}`.trim(),effectiveDate:row.effective_date,version:row.version,periods:data.periods,courses:data.courses};
}
function checkSelection(db:Store,version:number) {
  const state=selection(db);conflict(state.version,version);return state;
}
function checkCurrent(db:Store,v:z.infer<typeof guardSchema>) {
  const state=checkSelection(db,v.selectionVersion);
  if(state.templateId!==v.templateId)throw new HttpError(409,'当前使用的课表已切换，请刷新后重试');
  const row=state.templateId?getTemplate(db,state.templateId):null;
  conflict(row?.version??0,v.version);return row;
}
function validateCourses(periods:Period[],courses:Course[]) {
  const ordered=[...periods].sort((a,b)=>a.id-b.id);
  if(new Set(periods.map(p=>p.id)).size!==periods.length||new Set(courses.map(c=>c.id)).size!==courses.length)throw new HttpError(400,'节次或课程编号重复');
  ordered.forEach((p,i)=>{if(p.start>=p.end||(i&&p.start<ordered[i-1].end))throw new HttpError(400,'上下课时间重叠或顺序错误')});
  for(const c of courses){if(c.endPeriod<c.startPeriod||!periods.some(p=>p.id===c.startPeriod)||!periods.some(p=>p.id===c.endPeriod))throw new HttpError(400,'课程节次无效');for(const d of courses)if(c.id!==d.id&&c.day===d.day&&c.startPeriod<=d.endPeriod&&d.startPeriod<=c.endPeriod)throw new HttpError(400,`${c.name} 与 ${d.name} 时间冲突`)}
}
function templateOnDate(db:Store,row:TemplateRow|null,date:string) {
  const data=row?describeTemplate(row):{id:null,name:'当前课表',effectiveDate:null,version:0,periods:defaultPeriods,courses:[] as Course[]};
  const exceptions=row?db.all('SELECT * FROM timetable_exceptions WHERE template_id=? AND date=?',row.id,date).map(r=>({id:r.id,date:r.date,courseId:r.course_id,action:r.action,course:json<Course|null>(r.course,null)})):[];
  const weekday=new Date(`${date}T12:00:00+08:00`).getUTCDay()||7;
  let today=data.courses.filter(c=>c.day===weekday);
  for(const e of exceptions){today=today.filter(c=>c.id!==e.courseId);if(e.action==='replace'&&e.course)today.push({...e.course,day:weekday})}
  today.sort((a,b)=>a.startPeriod-b.startPeriod);
  return {date,templateId:data.id,templateName:data.name,effectiveDate:data.effectiveDate,version:data.version,periods:data.periods,courses:data.courses,exceptions,today};
}
function validateExceptionDates(db:Store,templateId:string) {
  const row=getTemplate(db,templateId);
  for(const {date} of db.all<{date:string}>('SELECT DISTINCT date FROM timetable_exceptions WHERE template_id=?',templateId)){
    const t=templateOnDate(db,row,date);
    for(const e of t.exceptions)if(!t.courses.some(c=>c.id===e.courseId))throw new HttpError(400,'此模板仍有对应课程的调课记录，请先清理对应日期的调整');
    validateCourses(t.periods,t.today);
  }
}
function saveTemplate(db:Store,row:TemplateRow|null,v:z.infer<typeof templateSchema>) {
  validateCourses(v.periods,v.courses);
  const data=JSON.stringify({name:v.name,periods:v.periods,courses:v.courses}),id=row?.id??uid();
  if(row)db.run('UPDATE timetable_templates SET data=?,version=version+1,updated_at=? WHERE id=?',data,now(),id);
  else db.run('INSERT INTO timetable_templates VALUES(?,?,?,?,?)',id,null,data,1,now());
  validateExceptionDates(db,id);return getTemplate(db,id);
}
function bumpVersion(db:Store,id:string) {db.run('UPDATE timetable_templates SET version=version+1,updated_at=? WHERE id=?',now(),id)}
export function getTimetable(db:Store,date=shanghaiDate()) {
  return db.transaction(()=>{
    const state=selection(db),row=state.templateId?getTemplate(db,state.templateId):null;
    const {semesterStart,semesterEnd,holidays}=db.setting('class',defaultConfig);
    const table=templateOnDate(db,row,date);
    const isClassDay=date>=semesterStart&&date<=semesterEnd&&!holidays.includes(date);
    return {...table,selectionVersion:state.version,config:{semesterStart,semesterEnd,holidays},today:isClassDay?table.today:[]};
  });
}
export function registerTimetable(app:FastifyInstance,db:Store) {
  app.get('/api/public/timetable',async req=>{const q=parse(z.object({date:dateSchema.optional()}),req.query);return getTimetable(db,q.date)});
  app.get('/api/timetable/templates',async req=>{
    requirePermission(req,'timetable.templates.read');return db.transaction(()=>{
      const state=selection(db);
      return {templates:db.all<TemplateRow>('SELECT * FROM timetable_templates ORDER BY updated_at DESC,id').map(describeTemplate),activeTemplateId:state.templateId,selectionVersion:state.version};
    });
  });
  app.put('/api/timetable',async req=>{
    const u=requirePermission(req,'timetable.current.edit'),v=parse(templateSchema.extend(guardSchema.shape),req.body);
    return db.transaction(()=>{
      const old=checkCurrent(db,v),saved=saveTemplate(db,old,v);
      if(!old)db.setSetting('timetable.selection',{templateId:saved.id,version:v.selectionVersion+1});
      db.audit(u.id,'timetable.save',saved.id,v);return getTimetable(db);
    });
  });
  app.post('/api/timetable/templates',async req=>{
    const u=requirePermission(req,'timetable.templates.create'),v=parse(templateSchema,req.body);
    return db.transaction(()=>{
      checkSelection(db,v.selectionVersion);const saved=saveTemplate(db,null,v);
      db.audit(u.id,'timetable.template.create',saved.id,v);return describeTemplate(saved);
    });
  });
  app.put<{Params:{id:string}}>('/api/timetable/templates/:id',async req=>{
    const u=requirePermission(req,'timetable.templates.edit'),v=parse(editSchema,req.body);
    return db.transaction(()=>{
      const state=checkSelection(db,v.selectionVersion);const old=getTemplate(db,req.params.id);conflict(old.version,v.version);
      if(state.templateId===old.id)requirePermission(req,'timetable.current.edit');
      const saved=saveTemplate(db,old,v);db.audit(u.id,'timetable.template.save',saved.id,v);return describeTemplate(saved);
    });
  });
  app.post<{Params:{id:string}}>('/api/timetable/templates/:id/apply',async req=>{
    const u=requirePermission(req,'timetable.templates.apply'),v=parse(selectionSchema.extend({version:z.number().int().positive()}),req.body);
    return db.transaction(()=>{
      checkSelection(db,v.selectionVersion);const row=getTemplate(db,req.params.id);conflict(row.version,v.version);
      const template=describeTemplate(row);validateCourses(template.periods,template.courses);validateExceptionDates(db,row.id);
      db.setSetting('timetable.selection',{templateId:row.id,version:v.selectionVersion+1});
      db.audit(u.id,'timetable.template.apply',row.id,v);return getTimetable(db);
    });
  });
  app.post('/api/timetable/exceptions',async req=>{
    const u=requirePermission(req,'timetable.exceptions.write');
    const v=parse(guardSchema.extend({date:dateSchema,courseId:z.string().min(1),action:z.enum(['cancel','replace']),course:courseSchema.optional()}),req.body);
    if(v.action==='replace'&&!v.course)throw new HttpError(400,'请填写调整后的课程');
    const day=new Date(`${v.date}T12:00:00+08:00`).getUTCDay()||7;
    return db.transaction(()=>{
      const row=checkCurrent(db,v),table=templateOnDate(db,row,v.date);
      if(!row||!table.courses.some(c=>c.id===v.courseId))throw new HttpError(404,'原课程不存在');
      const id=table.exceptions.find(e=>e.courseId===v.courseId)?.id??uid();
      const course=v.action==='replace'?{...v.course,id:v.courseId,day}:null;
      db.run('INSERT INTO timetable_exceptions(id,date,course_id,action,course,created_at,template_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(template_id,date,course_id) DO UPDATE SET action=excluded.action,course=excluded.course',id,v.date,v.courseId,v.action,course?JSON.stringify(course):null,now(),row.id);
      const updated=templateOnDate(db,row,v.date);validateCourses(updated.periods,updated.today);bumpVersion(db,row.id);
      db.audit(u.id,'timetable.exception',id,v);return {id,...v};
    });
  });
  app.delete<{Params:{id:string}}>('/api/timetable/exceptions/:id',async req=>{
    const u=requirePermission(req,'timetable.exceptions.remove'),v=parse(guardSchema,req.body);
    return db.transaction(()=>{
      const row=checkCurrent(db,v);
      const old=db.get<{date:string}>('SELECT date FROM timetable_exceptions WHERE id=? AND template_id=?',req.params.id,row?.id??null);
      if(!old||!row)throw new HttpError(404,'调课记录不存在');
      db.run('DELETE FROM timetable_exceptions WHERE id=?',req.params.id);
      const t=templateOnDate(db,row,old.date);validateCourses(t.periods,t.today);bumpVersion(db,row.id);
      db.audit(u.id,'timetable.exception.remove',req.params.id,{});return {ok:true};
    });
  });
}
