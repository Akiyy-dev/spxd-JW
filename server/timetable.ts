import type { FastifyInstance } from 'fastify';
import type { Store } from './db.ts';
import {z} from 'zod';
import {conflict,dateSchema,HttpError,json,now,parse,requireManager,shanghaiDate,uid} from './common.ts';
import {defaultConfig} from './catalog.ts';
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const periodSchema=z.object({id:z.number().int().min(1).max(30),label:z.string().min(1).max(20),start:time,end:time});
const courseSchema=z.object({id:z.string().min(1).max(100),name:z.string().trim().min(1).max(100),teacher:z.string().max(100).default(''),room:z.string().max(100).default(''),day:z.number().int().min(1).max(7),startPeriod:z.number().int().positive(),endPeriod:z.number().int().positive(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),notes:z.string().max(500).default('')});
export type Course=z.infer<typeof courseSchema>;
const templateSchema=z.object({effectiveDate:dateSchema,periods:z.array(periodSchema).min(1).max(30),courses:z.array(courseSchema).max(200),version:z.number().int().min(0)});
export const defaultPeriods=[{id:1,label:'第1节',start:'08:00',end:'08:45'},{id:2,label:'第2节',start:'08:55',end:'09:40'},{id:3,label:'第3节',start:'10:00',end:'10:45'},{id:4,label:'第4节',start:'10:55',end:'11:40'},{id:5,label:'第5节',start:'14:00',end:'14:45'},{id:6,label:'第6节',start:'14:55',end:'15:40'},{id:7,label:'第7节',start:'16:00',end:'16:45'},{id:8,label:'第8节',start:'16:55',end:'17:40'}];
function validateCourses(periods:z.infer<typeof periodSchema>[],courses:Course[]) {
  const ordered=[...periods].sort((a,b)=>a.id-b.id);
  if(new Set(periods.map(p=>p.id)).size!==periods.length||new Set(courses.map(c=>c.id)).size!==courses.length)throw new HttpError(400,'节次或课程编号重复');
  ordered.forEach((p,i)=>{if(p.start>=p.end||(i&&p.start<ordered[i-1].end))throw new HttpError(400,'上下课时间重叠或顺序错误')});
  for(const c of courses){if(c.endPeriod<c.startPeriod||!periods.some(p=>p.id===c.startPeriod)||!periods.some(p=>p.id===c.endPeriod))throw new HttpError(400,'课程节次无效');for(const d of courses)if(c.id!==d.id&&c.day===d.day&&c.startPeriod<=d.endPeriod&&d.startPeriod<=c.endPeriod)throw new HttpError(400,`${c.name} 与 ${d.name} 时间冲突`)}
}
function validateExceptionDates(db:Store,from:string){
  for(const {date} of db.all<{date:string}>('SELECT DISTINCT date FROM timetable_exceptions WHERE date>=?',from)){
    const t=getEffectiveTimetable(db,date);
    for(const e of t.exceptions)if(!t.courses.some((c:Course)=>c.id===e.courseId))throw new HttpError(400,'新的周课表包含尚未处理的旧调课记录，请先清理对应日期的调整');
    validateCourses(t.periods,t.today);
  }
}
function getEffectiveTimetable(db:Store,date:string) {
  const row=db.get('SELECT * FROM timetable_templates WHERE effective_date<=? ORDER BY effective_date DESC LIMIT 1',date);
  const data=json(row?.data,{periods:defaultPeriods,courses:[] as Course[]});
  const exceptions=db.all('SELECT * FROM timetable_exceptions WHERE date=?',date).map(r=>({id:r.id,date:r.date,courseId:r.course_id,action:r.action,course:json<Course|null>(r.course,null)}));
  const weekday=new Date(`${date}T12:00:00+08:00`).getUTCDay()||7;
  let today=data.courses.filter((c:Course)=>c.day===weekday);
  for(const e of exceptions){today=today.filter((c:Course)=>c.id!==e.courseId);if(e.action==='replace'&&e.course)today.push({...e.course,day:weekday})}
  today.sort((a:Course,b:Course)=>a.startPeriod-b.startPeriod);
  return {date,effectiveDate:row?.effective_date??date,version:row?.version??0,...data,exceptions,today};
}
export function getTimetable(db:Store,date=shanghaiDate()) {
  const {semesterStart,semesterEnd,holidays}=db.setting('class',defaultConfig);
  const table=getEffectiveTimetable(db,date);
  const isClassDay=date>=semesterStart&&date<=semesterEnd&&!holidays.includes(date);
  return {...table,config:{semesterStart,semesterEnd,holidays},today:isClassDay?table.today:[]};
}
export function registerTimetable(app:FastifyInstance,db:Store) {
  app.get('/api/public/timetable',async req=>{const q=parse(z.object({date:dateSchema.optional()}),req.query);return getTimetable(db,q.date)});
  app.put('/api/timetable',async req=>{
    const u=requireManager(req),v=parse(templateSchema,req.body);validateCourses(v.periods,v.courses);
    const old=db.get('SELECT * FROM timetable_templates WHERE effective_date=?',v.effectiveDate);conflict(old?.version??0,v.version);
    if(v.effectiveDate<shanghaiDate()&&db.get('SELECT id FROM timetable_templates LIMIT 1'))throw new HttpError(400,'历史周课表保留不变，请设置今天或之后的生效日期');
    db.transaction(()=>{
      if(old)db.run('UPDATE timetable_templates SET data=?,version=version+1,updated_at=? WHERE id=?',JSON.stringify({periods:v.periods,courses:v.courses}),now(),old.id);
      else db.run('INSERT INTO timetable_templates VALUES(?,?,?,?,?)',uid(),v.effectiveDate,JSON.stringify({periods:v.periods,courses:v.courses}),1,now());
      validateExceptionDates(db,v.effectiveDate);db.audit(u.id,'timetable.save',v.effectiveDate,v);
    });return getTimetable(db,v.effectiveDate);
  });
  app.post('/api/timetable/exceptions',async req=>{
    const u=requireManager(req);
    const v=parse(z.object({date:dateSchema,courseId:z.string().min(1),action:z.enum(['cancel','replace']),course:courseSchema.optional()}),req.body);
    if(v.action==='replace'&&!v.course)throw new HttpError(400,'请填写调整后的课程');
    const day=new Date(`${v.date}T12:00:00+08:00`).getUTCDay()||7;
    return db.transaction(()=>{
      const table=getEffectiveTimetable(db,v.date);
      if(!table.courses.some((c:Course)=>c.id===v.courseId))throw new HttpError(404,'原课程不存在');
      const id=table.exceptions.find(e=>e.courseId===v.courseId)?.id??uid();
      const course=v.action==='replace'?{...v.course,id:v.courseId,day}:null;
      db.run('INSERT INTO timetable_exceptions VALUES(?,?,?,?,?,?) ON CONFLICT(date,course_id) DO UPDATE SET action=excluded.action,course=excluded.course',
        id,v.date,v.courseId,v.action,course?JSON.stringify(course):null,now());
      const updated=getEffectiveTimetable(db,v.date);
      validateCourses(updated.periods,updated.today);
      db.audit(u.id,'timetable.exception',id,v);
      return {id,...v};
    });
  });
  app.delete<{Params:{id:string}}>('/api/timetable/exceptions/:id',async req=>{
    const u=requireManager(req);
    return db.transaction(()=>{
      const old=db.get<{date:string}>('SELECT date FROM timetable_exceptions WHERE id=?',req.params.id);
      if(!old)throw new HttpError(404,'调课记录不存在');
      db.run('DELETE FROM timetable_exceptions WHERE id=?',req.params.id);
      const t=getEffectiveTimetable(db,old.date);
      validateCourses(t.periods,t.today);
      db.audit(u.id,'timetable.exception.remove',req.params.id,{});
      return {ok:true};
    });
  });
}
