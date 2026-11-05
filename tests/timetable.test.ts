import {test} from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {createStore} from '../server/db.ts';import {registerTimetable} from '../server/timetable.ts';
import {registerCatalog} from '../server/catalog.ts';
import {shanghaiDate} from '../server/common.ts';
const periods=[{id:1,label:'第1节',start:'08:00',end:'08:45'},{id:2,label:'第2节',start:'08:55',end:'09:40'}];
const course={id:'a',name:'数学',teacher:'王老师',room:'301',day:1,startPeriod:1,endPeriod:2,color:'#0f766e',notes:''};
async function setup(manager=true){const db=createStore();db.run("INSERT INTO users(id,username,name,password_hash,role,created_at) VALUES('m','m','班委','x','committee','2026-01-01')");const app=Fastify();app.decorateRequest('user',null);app.addHook('onRequest',async r=>{r.user=manager?{id:'m',name:'班委',username:'m',role:'committee',active:true,financeManage:false,mustChangePassword:false,version:1}:null});app.setErrorHandler((e:any,_r,p)=>p.code(e.statusCode??500).send({message:e.message}));registerTimetable(app,db);registerCatalog(app,db);await app.ready();return{db,app}}
test('guest can read timetable but cannot edit it',async()=>{const{db,app}=await setup(false);assert.equal((await app.inject({url:'/api/public/timetable?date=2026-11-02'})).statusCode,200);assert.equal((await app.inject({method:'PUT',url:'/api/timetable',payload:{}})).statusCode,401);await app.close();db.close()});
test('fixed courses repeat weekly, conflicts rejected and cancellation affects one date',async()=>{const{db,app}=await setup();let r=await app.inject({method:'PUT',url:'/api/timetable',payload:{effectiveDate:'2026-09-01',periods,courses:[course],version:0}});assert.equal(r.statusCode,200,r.body);for(const date of ['2026-11-02','2026-11-09'])assert.equal((await app.inject({url:`/api/public/timetable?date=${date}`})).json().today.length,1);r=await app.inject({method:'PUT',url:'/api/timetable',payload:{effectiveDate:'2026-09-01',periods,courses:[course,{...course,id:'b'}],version:1}});assert.equal(r.statusCode,400);r=await app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{date:'2026-11-02',courseId:'a',action:'cancel'}});assert.equal(r.statusCode,200,r.body);assert.equal((await app.inject({url:'/api/public/timetable?date=2026-11-02'})).json().today.length,0);assert.equal((await app.inject({url:'/api/public/timetable?date=2026-11-09'})).json().today.length,1);await app.close();db.close()});
test('removing cancellation rejects a conflicting replacement and rolls back',async()=>{const{db,app}=await setup();const a={...course,endPeriod:1},b={...course,id:'b',name:'英语',startPeriod:2};await app.inject({method:'PUT',url:'/api/timetable',payload:{effectiveDate:'2026-09-01',periods,courses:[a,b],version:0}});const cancel=(await app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{date:'2026-11-02',courseId:'a',action:'cancel'}})).json();const replaced=await app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{date:'2026-11-02',courseId:'b',action:'replace',course:{...b,startPeriod:1,endPeriod:1}}});assert.equal(replaced.statusCode,200,replaced.body);const remove=await app.inject({method:'DELETE',url:`/api/timetable/exceptions/${cancel.id}`});assert.equal(remove.statusCode,400);assert.ok(db.get('SELECT id FROM timetable_exceptions WHERE id=?',cancel.id));await app.close();db.close()});

test('holiday display cannot hide conflicts when adding or deleting timetable exceptions', async t => {
  const {db, app} = await setup();
  t.after(async () => { await app.close(); db.close(); });
  const date = '2026-11-02';
  const a = {...course,endPeriod:1};
  const b = {...course,id:'b',name:'英语',startPeriod:2};
  const template = await app.inject({method:'PUT',url:'/api/timetable',payload:{
    effectiveDate:'2026-09-01',periods,courses:[a,b],version:0,
  }});
  assert.equal(template.statusCode, 200);
  const holiday = await app.inject({method:'PUT',url:'/api/class',payload:{version:1,config:{holidays:[date]}}});
  assert.equal(holiday.statusCode, 200);
  const addException = (payload: object) => app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{date,...payload}});
  const moveB = {courseId:b.id,action:'replace',course:{...b,startPeriod:1,endPeriod:1}};
  assert.equal((await addException(moveB)).statusCode, 400);
  const cancelled = await addException({courseId:a.id,action:'cancel'});
  assert.equal(cancelled.statusCode, 200);
  assert.equal((await addException(moveB)).statusCode, 200);
  const removed = await app.inject({method:'DELETE',url:`/api/timetable/exceptions/${cancelled.json().id}`});
  assert.equal(removed.statusCode, 400);
  const read = () => app.inject({url:`/api/public/timetable?date=${date}`});
  assert.deepEqual((await read()).json().today, []);
  const restore = await app.inject({method:'PUT',url:'/api/class',payload:{
    version:holiday.json().version,config:{holidays:[]},
  }});
  assert.equal(restore.statusCode, 200);
  assert.deepEqual((await read()).json().today.map((c:{id:string}) => c.id), [b.id]);
});

test('weekly templates reject collisions with exceptions even outside the semester', async t => {
  const {db, app} = await setup();
  t.after(async () => { await app.close(); db.close(); });
  const date = shanghaiDate(new Date(Date.now() + 7 * 86400000));
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
  const first = {...course,day,endPeriod:1};
  const second = {...course,id:'b',day,name:'英语',startPeriod:2};
  const save = (courses: typeof first[], version: number) => app.inject({
    method:'PUT',url:'/api/timetable',payload:{effectiveDate:date,periods,courses,version},
  });
  const term = await app.inject({method:'PUT',url:'/api/class',payload:{
    version:1,config:{semesterStart:'2000-01-01',semesterEnd:'2000-02-01'},
  }});
  assert.equal(term.statusCode, 200);
  assert.equal((await save([second], 0)).statusCode, 200);
  assert.equal((await app.inject({method:'POST',url:'/api/timetable/exceptions',payload:{
    date,courseId:second.id,action:'replace',course:{...second,startPeriod:1,endPeriod:1},
  }})).statusCode, 200);
  const edited = await save([first,second], 1);
  assert.equal(edited.statusCode, 400);
  const {courses, version, today} = (await app.inject({url:`/api/public/timetable?date=${date}`})).json();
  assert.equal(version, 1);
  assert.deepEqual(courses.map((c:{id:string}) => c.id), [second.id]);
  assert.deepEqual(today, []);
});
