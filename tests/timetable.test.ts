import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore, type Store} from '../server/db.ts';
import {registerTimetable} from '../server/timetable.ts';
import {registerCatalog} from '../server/catalog.ts';
import {shanghaiDate} from '../server/common.ts';

const periods=[{id:1,label:'第1节',start:'08:00',end:'08:45'},{id:2,label:'第2节',start:'08:55',end:'09:40'}];
const course={id:'a',name:'数学',teacher:'王老师',room:'301',day:1,startPeriod:1,endPeriod:2,color:'#0f766e',notes:''};
async function setup(t:TestContext,role:'committee'|'student'|'admin'|null='committee',db:Store=createStore()) {
  db.run("INSERT OR IGNORE INTO users(id,username,name,password_hash,role,created_at) VALUES('m','m','班委','x','committee','2026-01-01')");
  const app=Fastify();app.decorateRequest('user',null);
  app.addHook('onRequest',async r=>{r.user=role?{id:'m',name:'班委',username:'m',role,inClass:role!=='admin',active:true,financeManage:false,mustChangePassword:false,version:1}:null});
  app.setErrorHandler((e:any,_r,p)=>p.code(e.statusCode??500).send({message:e.message}));
  registerTimetable(app,db);registerCatalog(app,db);await app.ready();
  t.after(async()=>{await app.close();db.close()});
  const read=async(date='2026-11-02')=>(await app.inject({url:`/api/public/timetable?date=${date}`})).json();
  const guard=(table:any)=>({templateId:table.templateId,version:table.version,selectionVersion:table.selectionVersion});
  const save=async(courses=[course],table?:any)=>{table??=await read();return app.inject({method:'PUT',url:'/api/timetable',payload:{...guard(table),name:'常用课表',periods,courses}})};
  const draft=async(name='备用课表',courses=[{...course,id:'b',name:'英语'}])=>app.inject({method:'POST',url:'/api/timetable/templates',payload:{name,periods,courses,selectionVersion:(await read()).selectionVersion}});
  const apply=async(template:any,state?:any)=>app.inject({method:'POST',url:`/api/timetable/templates/${template.id}/apply`,payload:{version:template.version,selectionVersion:(state??await read()).selectionVersion}});
  const exception=async(payload:object,table?:any)=>app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{date:'2026-11-02',...guard(table??await read()),...payload}});
  const remove=async(id:string)=>app.inject({method:'DELETE',url:`/api/timetable/exceptions/${id}`,payload:guard(await read())});
  return {db,app,read,guard,save,draft,apply,exception,remove};
}

test('guests and students can read but cannot save, list drafts, apply or adjust templates',async t=>{
  for(const role of [null,'student'] as const){const{app}=await setup(t,role);const status=role?403:401;
    assert.equal((await app.inject({url:'/api/public/timetable?date=2026-11-02'})).statusCode,200);
    for(const [method,url] of [['GET','/api/timetable/templates'],['PUT','/api/timetable'],['POST','/api/timetable/templates'],['PUT','/api/timetable/templates/example'],['POST','/api/timetable/templates/example/apply'],['POST','/api/timetable/exceptions'],['DELETE','/api/timetable/exceptions/example']] as const)
      assert.equal((await app.inject({method,url,...(method==='GET'?{}:{payload:{}})})).statusCode,status,`${role}: ${method} ${url}`);
  }
});

test('editing the active weekly template updates every week immediately without creating dated templates',async t=>{
  const{db,save,read}=await setup(t);let response=await save();assert.equal(response.statusCode,200,response.body);
  const original=await read();response=await save([{...course,name:'更新后的数学'}],original);assert.equal(response.statusCode,200,response.body);
  for(const date of ['2026-11-02','2026-11-09','2026-11-16']){const table=await read(date);assert.equal(table.today[0].name,'更新后的数学');assert.equal(table.templateId,original.templateId)}
  assert.equal(db.get<{count:number}>('SELECT COUNT(*) count FROM timetable_templates')?.count,1);
  assert.equal((await save([course],original)).statusCode,409);
});

test('saving named templates never switches the active schedule; apply is explicit and rejects stale saves',async t=>{
  const{app,save,draft,apply,read}=await setup(t);assert.equal((await save()).statusCode,200);const original=await read();
  const created=await draft();assert.equal(created.statusCode,200,created.body);const alternative=created.json();
  assert.equal((await read()).courses[0].name,'数学');
  const templates=(await app.inject({url:'/api/timetable/templates'})).json();assert.equal(templates.templates.length,2);assert.equal(templates.activeTemplateId,original.templateId);
  const applied=await apply(alternative);assert.equal(applied.statusCode,200,applied.body);assert.equal((await read()).courses[0].name,'英语');
  assert.equal((await save([{...course,name:'过期编辑'}],original)).statusCode,409);
  assert.equal((await apply(alternative,original)).statusCode,409);
  const fresh=await read();assert.equal((await app.inject({method:'PUT',url:`/api/timetable/templates/${alternative.id}`,payload:{name:'备用新版',periods,courses:[{...course,id:'b',name:'英语新版'}],version:alternative.version,selectionVersion:fresh.selectionVersion}})).statusCode,200);
  assert.equal((await read()).courses[0].name,'英语新版');
  assert.equal((await apply(alternative)).statusCode,409);
});

test('creating the first draft leaves an empty active schedule until it is explicitly applied',async t=>{
  const{draft,read,apply}=await setup(t);const created=await draft();assert.equal(created.statusCode,200,created.body);
  assert.equal((await read()).templateId,null);assert.deepEqual((await read()).courses,[]);
  assert.equal((await apply(created.json())).statusCode,200);assert.equal((await read()).courses[0].name,'英语');
});

test('simultaneous apply requests using the same selection version allow exactly one winner',async t=>{
  const{save,draft,apply,read}=await setup(t);await save();const first=(await draft('第一套')).json(),second=(await draft('第二套')).json();const before=await read();
  const results=await Promise.all([apply(first,before),apply(second,before)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
});

test('weekly course conflicts are rejected and cancellation affects one date only',async t=>{
  const{save,read,exception}=await setup(t);assert.equal((await save()).statusCode,200);
  assert.equal((await save([course,{...course,id:'b'}])).statusCode,400);
  assert.equal((await exception({courseId:'a',action:'cancel'})).statusCode,200);
  assert.equal((await read()).today.length,0);assert.equal((await read('2026-11-09')).today.length,1);
});

test('exceptions are preserved per template across switches and reject a stale adjustment',async t=>{
  const{save,draft,read,apply,exception}=await setup(t);await save();const before=await read();
  assert.equal((await exception({courseId:'a',action:'cancel'})).statusCode,200);const original=await read();
  const other=(await draft('另一套',[{...course,name:'物理'}])).json();assert.equal((await apply(other)).statusCode,200);
  assert.equal((await read()).today[0].name,'物理');assert.equal((await read()).exceptions.length,0);
  assert.equal((await exception({courseId:'a',action:'cancel'},before)).statusCode,409);
  assert.equal((await exception({courseId:'a',action:'cancel'})).statusCode,200);
  assert.equal((await apply({id:original.templateId,version:original.version})).statusCode,200);assert.equal((await read()).today.length,0);
  assert.equal((await read()).exceptions.length,1);
});

test('holiday display cannot hide conflicts when adding or deleting timetable exceptions',async t=>{
  const{db,app,save,exception,remove,read}=await setup(t);const a={...course,endPeriod:1},b={...course,id:'b',name:'英语',startPeriod:2};
  assert.equal((await save([a,b])).statusCode,200);
  const holiday=await app.inject({method:'PUT',url:'/api/class',payload:{version:1,config:{holidays:['2026-11-02']}}});assert.equal(holiday.statusCode,200);
  const move={courseId:b.id,action:'replace',course:{...b,startPeriod:1,endPeriod:1}};
  assert.equal((await exception(move)).statusCode,400);
  const cancelled=await exception({courseId:a.id,action:'cancel'});assert.equal(cancelled.statusCode,200);
  assert.equal((await exception(move)).statusCode,200);assert.equal((await remove(cancelled.json().id)).statusCode,400);
  assert.ok(db.get('SELECT id FROM timetable_exceptions WHERE id=?',cancelled.json().id));assert.deepEqual((await read()).today,[]);
  assert.equal((await app.inject({method:'PUT',url:'/api/class',payload:{version:holiday.json().version,config:{holidays:[]}}})).statusCode,200);
  assert.deepEqual((await read()).today.map((c:{id:string})=>c.id),['b']);
});

test('weekly edits reject orphaned adjustments and collisions even outside the semester',async t=>{
  const{app,save,read,exception}=await setup(t);const first={...course,endPeriod:1},second={...course,id:'b',name:'英语',startPeriod:2};
  assert.equal((await app.inject({method:'PUT',url:'/api/class',payload:{version:1,config:{semesterStart:'2000-01-01',semesterEnd:'2000-02-01'}}})).statusCode,200);
  assert.equal((await save([second])).statusCode,200);
  assert.equal((await exception({courseId:'b',action:'replace',course:{...second,startPeriod:1,endPeriod:1}})).statusCode,200);
  const before=await read();assert.equal((await save([first,second])).statusCode,400);assert.equal((await save([first])).statusCode,400);
  const after=await read();assert.equal(after.version,before.version);assert.deepEqual(after.courses,before.courses);assert.deepEqual(after.today,[]);
});

test('migration retains dated templates and old adjustments but selects today only once',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'classroom-timetable-'));const path=join(directory,'legacy.sqlite');
  const legacy=new DatabaseSync(path);legacy.exec(`CREATE TABLE timetable_templates(id TEXT PRIMARY KEY,effective_date TEXT NOT NULL UNIQUE,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);CREATE TABLE timetable_exceptions(id TEXT PRIMARY KEY,date TEXT NOT NULL,course_id TEXT NOT NULL,action TEXT NOT NULL,course TEXT,created_at TEXT NOT NULL,UNIQUE(date,course_id));`);
  const insert=legacy.prepare('INSERT INTO timetable_templates VALUES(?,?,?,?,?)');insert.run('old','2000-01-01',JSON.stringify({periods,courses:[course]}),3,'old timestamp');insert.run('future','2099-01-01',JSON.stringify({periods,courses:[{...course,name:'未来课表'}]}),7,'future timestamp');
  legacy.prepare('INSERT INTO timetable_exceptions VALUES(?,?,?,?,?,?)').run('cancel','2026-11-02','a','cancel',null,'old timestamp');legacy.close();
  const{db,app,read,save}=await setup(t,'committee',createStore(path));t.after(()=>rmSync(directory,{recursive:true,force:true}));const table=await read('2099-01-05');assert.equal(table.templateId,'old');assert.equal(table.courses[0].name,'数学');assert.equal(table.version,3);
  assert.equal((await read()).today.length,0);assert.ok(db.get('SELECT id FROM timetable_exceptions WHERE id=?','cancel'));
  const templates=(await app.inject({url:'/api/timetable/templates'})).json();assert.equal(templates.templates.length,2);assert.equal(templates.templates.find((v:any)=>v.id==='future').version,7);
  assert.equal((await save([{...course,name:'旧课表可以直接修改'}])).statusCode,200);
  assert.equal((await read(shanghaiDate())).courses[0].name,'旧课表可以直接修改');
  const reopened=createStore(path);assert.equal(reopened.get<{count:number}>('SELECT COUNT(*) count FROM timetable_templates')?.count,2);reopened.close();
});
