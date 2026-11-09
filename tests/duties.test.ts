import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import {buildApp} from '../server/app.ts';
import {createStore} from '../server/db.ts';
import type {Permission, Role} from '../shared/permissions.ts';
import type {DutiesData} from '../shared/duties.ts';

const duty = {id:'first',weekday:1,area:'教室',names:['张同学','李同学']};

async function fixture(t:TestContext) {
  const db=createStore(), app=await buildApp({db});
  t.after(async()=>{await app.close();db.close();});
  function session(id:string, role:Role='committee', permissions:Permission[]=[]) {
    db.run('INSERT INTO users(id,username,name,password_hash,role,permissions,must_change_password,created_at) VALUES(?,?,?,?,?,?,0,?)',id,id,id,'unused',role,JSON.stringify(permissions),'2026-11-09');
    const token=randomBytes(32).toString('base64url');
    db.run('INSERT INTO sessions VALUES(?,?,?)',createHash('sha256').update(token).digest('hex'),id,'2099-01-01T00:00:00.000Z');
    return {class_session:token};
  }
  return {db,app,session};
}

function legacyDatabase(t:TestContext, raw:string, weekly?:unknown) {
  const root=resolve(tmpdir()), directory=mkdtempSync(join(root,'weekly-duties-')), path=join(directory,'legacy.sqlite');
  t.after(()=>{
    assert.ok(resolve(directory).startsWith(root+sep));
    rmSync(directory,{recursive:true,force:true});
  });
  const legacy=new DatabaseSync(path);
  legacy.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  legacy.prepare('INSERT INTO settings VALUES(?,?)').run('duties',raw);
  if(weekly!==undefined)legacy.prepare('INSERT INTO settings VALUES(?,?)').run('weekly_duties',JSON.stringify(weekly));
  legacy.close();
  return path;
}

test('weekly duties require an active session and a changed initial password',async t=>{
  const {db,app,session}=await fixture(t);
  const cookies=session('student','student');
  for(const method of ['GET','PUT'] as const){
    const request={method,url:'/api/duties',...(method==='PUT'?{payload:{duties:[],version:1}}:{})};
    assert.equal((await app.inject(request)).statusCode,401);
    db.run('UPDATE users SET active=0 WHERE id=?','student');
    assert.equal((await app.inject({...request,cookies})).statusCode,401);
    db.run('UPDATE users SET active=1,must_change_password=1 WHERE id=?','student');
    assert.equal((await app.inject({...request,cookies})).statusCode,403);
    db.run('UPDATE users SET must_change_password=0 WHERE id=?','student');
  }
  const response=await app.inject({url:'/api/duties',cookies});
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json(),{duties:[],version:1});
});

test('only Admin, committee and explicitly granted administrators can maintain weekly duties',async t=>{
  const {db,app,session}=await fixture(t);
  for(const [id,role,permissions,allowed] of [
    ['student','student',[],false],['empty-admin','admin',[],false],
    ['class-editor','admin',['class.settings.edit'],false],
    ['root','super_admin',[],true],['committee','committee',[],true],
    ['granted-admin','admin',['class.duties.edit'],true],
  ] as [string,Role,Permission[],boolean][]){
    const cookies=session(id,role,permissions);
    const read=await app.inject({url:'/api/duties',cookies});
    assert.equal(read.statusCode,200,read.body);
    const response=await app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties:[duty],version:read.json().version}});
    assert.equal(response.statusCode,allowed?200:403,id+': '+response.body);
  }
  assert.equal(db.all("SELECT * FROM audit WHERE action='duties.update'").length,3);
});

test('weekly edits trim text, preserve several areas on one weekday and support Sunday',async t=>{
  const {db,app,session}=await fixture(t), cookies=session('committee');
  const duties=[{...duty,id:' first ',area:' 教室 ',names:[' 张同学 ',' 李同学 ']},{id:'second',weekday:1,area:'走廊',names:[]},{id:'sunday',weekday:7,area:'图书角',names:['王同学']}];
  const response=await app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties,version:1}});
  assert.equal(response.statusCode,200,response.body);
  const expected={duties:[duty,duties[1],duties[2]],version:2};
  assert.deepEqual(response.json(),expected);
  assert.deepEqual((await app.inject({url:'/api/duties',cookies})).json(),expected);
  assert.deepEqual(db.setting('weekly_duties',null),expected);
  const audit=db.get("SELECT actor_id,entity_id,details FROM audit WHERE action='duties.update'");
  assert.equal(audit.actor_id,'committee');
  assert.equal(audit.entity_id,'weekly_duties');
  assert.deepEqual(JSON.parse(audit.details),{from:1,version:2});
});

test('invalid weekdays, IDs, text, limits and versions cannot partially replace weekly duties',async t=>{
  const {db,app,session}=await fixture(t), cookies=session('committee');
  const invalid=[
    ...[0,8,-1,1.5,'1',null].map(weekday=>({duties:[{...duty,weekday}],version:1})),
    {duties:[duty,{...duty,id:' first '}],version:1},
    ...['',' ', 'x'.repeat(101)].map(id=>({duties:[{...duty,id}],version:1})),
    ...['',' ', 'x'.repeat(101)].map(area=>({duties:[{...duty,area}],version:1})),
    ...['',' ', 'x'.repeat(101)].map(name=>({duties:[{...duty,names:[name]}],version:1})),
    {duties:[{...duty,names:Array(101).fill('同学')}],version:1},
    {duties:Array.from({length:1001},(_,i)=>({...duty,id:String(i)})),version:1},
    ...[0,-1,1.5,'1',null].map(version=>({duties:[duty],version})),
    {duties:[{id:'dated',date:'2026-11-09',area:'教室',names:[]}],version:1},
    {version:1},{duties:[]},
  ];
  for(const payload of invalid){
    const response=await app.inject({method:'PUT',url:'/api/duties',cookies,payload});
    assert.equal(response.statusCode,400,response.body);
  }
  assert.deepEqual((await app.inject({url:'/api/duties',cookies})).json(),{duties:[],version:1});
  assert.equal(db.all("SELECT * FROM audit WHERE action='duties.update'").length,0);
});

test('concurrent weekly saves have one winner and a stale request cannot overwrite it',async t=>{
  const {db,app,session}=await fixture(t), cookies=session('committee');
  const results=await Promise.all(['甲','乙'].map(area=>app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties:[{...duty,area}],version:1}})));
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const winner=results.find(r=>r.statusCode===200)!.json();
  assert.deepEqual((await app.inject({url:'/api/duties',cookies})).json(),winner);
  assert.equal(db.all("SELECT * FROM audit WHERE action='duties.update'").length,1);
});

test('weekly duties roll back when transaction audit cannot be recorded',async t=>{
  const {db,app,session}=await fixture(t), cookies=session('committee');
  db.sqlite.exec("CREATE TRIGGER reject_duties_audit BEFORE INSERT ON audit WHEN NEW.action='duties.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  const response=await app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties:[duty],version:1}});
  assert.equal(response.statusCode,500);
  assert.deepEqual((await app.inject({url:'/api/duties',cookies})).json(),{duties:[],version:1});
});

test('class settings and weekly duties save independently without sharing a version',async t=>{
  const {app,session}=await fixture(t), cookies=session('committee');
  const weekly=await app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties:[duty],version:1}});
  assert.equal(weekly.statusCode,200,weekly.body);
  const klass=await app.inject({method:'PUT',url:'/api/class',cookies,payload:{config:{name:'新班级'},version:1}});
  assert.equal(klass.statusCode,200,klass.body);
  assert.equal(klass.json().version,2);
  assert.equal('duties' in klass.json(),false);
  const cleared=await app.inject({method:'PUT',url:'/api/duties',cookies,payload:{duties:[],version:2}});
  assert.equal(cleared.statusCode,200,cleared.body);
  assert.deepEqual(cleared.json(),{duties:[],version:3});
  const current=(await app.inject({url:'/api/class',cookies})).json();
  assert.equal(current.config.name,'新班级');
  assert.equal(current.version,2);
  assert.equal('duties' in current,false);
});

test('old class duty saves require refresh and cannot change any bundled class or member data',async t=>{
  const {db,app,session}=await fixture(t), cookies=session('committee');
  db.setSetting('duties',[{id:'legacy',date:'2026-11-09',area:'原区域',names:[]}]);
  const original=db.get('SELECT value FROM settings WHERE key=?','duties').value;
  const response=await app.inject({method:'PUT',url:'/api/class',cookies,payload:{version:1,config:{name:'不应保存'},members:[{id:'committee',displayName:'不应保存'}],duties:[]}});
  assert.equal(response.statusCode,409,response.body);
  assert.match(response.json().message,/刷新/);
  assert.equal(db.setting<any>('class',{}).name,undefined);
  assert.equal(db.get('SELECT profile FROM users WHERE id=?','committee').profile,'{}');
  assert.equal(db.get('SELECT value FROM settings WHERE key=?','duties').value,original);
  assert.equal(db.all('SELECT * FROM audit').length,0);
  assert.deepEqual((await app.inject({url:'/api/duties',cookies})).json(),{duties:[],version:1});
});

test('migration converts civil dates to weekdays without merging any records and retains exact legacy backup',t=>{
  const raw=' [ {"id":"monday","date":"2026-11-09","area":"教室","names":["张同学"]}, {"id":"next-monday","date":"2026-11-16","area":"教室","names":["李同学"]}, {"id":"sunday","date":"2026-11-15","area":"走廊","names":[]}, {"id":"leap","date":"2024-02-29","area":"图书角","names":[]} ] ';
  const path=legacyDatabase(t,raw), db=createStore(path);
  try {
    assert.deepEqual(db.setting('weekly_duties',null),{duties:[
      {id:'monday',weekday:1,area:'教室',names:['张同学']},{id:'next-monday',weekday:1,area:'教室',names:['李同学']},
      {id:'sunday',weekday:7,area:'走廊',names:[]},{id:'leap',weekday:4,area:'图书角',names:[]},
    ],version:1});
    assert.equal(db.get('SELECT value FROM settings WHERE key=?','duties').value,raw);
    assert.equal(db.all('SELECT version FROM migrations WHERE version=5').length,1);
    db.setSetting('weekly_duties',{duties:[],version:4});
  } finally {db.close();}
  const restarted=createStore(path);
  try {
    assert.deepEqual(restarted.setting('weekly_duties',null),{duties:[],version:4});
    assert.equal(restarted.get('SELECT value FROM settings WHERE key=?','duties').value,raw);
    assert.equal(restarted.all('SELECT version FROM migrations WHERE version=5').length,1);
  } finally {restarted.close();}
});

test('migration never overwrites a pre-existing weekly schedule',t=>{
  const expected={duties:[duty],version:9};
  const path=legacyDatabase(t,'not valid JSON',expected), db=createStore(path);
  try {
    assert.deepEqual(db.setting('weekly_duties',null),expected);
    assert.equal(db.get('SELECT value FROM settings WHERE key=?','duties').value,'not valid JSON');
    assert.equal(db.all('SELECT version FROM migrations WHERE version=5').length,1);
  } finally {db.close();}
});

test('migration repairs legacy IDs without losing records and every repaired row remains independently editable',async t=>{
  const retainedUuid='13b3a140-a491-4d77-949e-ae27074c3a76';
  const legacy=['',' \t ','x'.repeat(101),'stable','stable',' stable ',' trimmed ',retainedUuid].map((id,index)=>({id,date:'2026-11-09',area:`区域${index+1}`,names:[`同学${index+1}`]}));
  const raw=' \n'+JSON.stringify(legacy,null,2)+'\n ';
  const path=legacyDatabase(t,raw), db=createStore(path), app=await buildApp({db});
  let saved:DutiesData;
  try {
    const migrated=db.setting<DutiesData>('weekly_duties',{duties:[],version:0});
    assert.equal(migrated.duties.length,8);
    assert.equal(new Set(migrated.duties.map(row=>row.id)).size,8);
    assert.deepEqual(migrated.duties.map(({weekday,area,names})=>({weekday,area,names})),[
      {weekday:1,area:'区域1',names:['同学1']},{weekday:1,area:'区域2',names:['同学2']},
      {weekday:1,area:'区域3',names:['同学3']},{weekday:1,area:'区域4',names:['同学4']},
      {weekday:1,area:'区域5',names:['同学5']},{weekday:1,area:'区域6',names:['同学6']},
      {weekday:1,area:'区域7',names:['同学7']},{weekday:1,area:'区域8',names:['同学8']},
    ]);
    assert.equal(migrated.duties[3].id,'stable');
    assert.equal(migrated.duties[6].id,'trimmed');
    assert.equal(migrated.duties[7].id,retainedUuid);
    for(const index of [0,1,2,4,5])assert.match(migrated.duties[index].id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    assert.equal(db.get('SELECT value FROM settings WHERE key=?','duties').value,raw);

    db.run("INSERT INTO users(id,username,name,password_hash,role,must_change_password,created_at) VALUES('editor','editor','班委','unused','committee',0,'2026-11-09')");
    const token=randomBytes(32).toString('base64url');
    db.run('INSERT INTO sessions VALUES(?,?,?)',createHash('sha256').update(token).digest('hex'),'editor','2099-01-01T00:00:00.000Z');
    const editedId=migrated.duties[4].id;
    const response=await app.inject({method:'PUT',url:'/api/duties',cookies:{class_session:token},payload:{duties:migrated.duties.map(row=>row.id===editedId?{...row,area:'已修改的区域'}:row),version:migrated.version}});
    assert.equal(response.statusCode,200,response.body);
    saved=response.json<DutiesData>();
    assert.equal(saved.version,2);
    assert.deepEqual(saved.duties.map(row=>row.area),['区域1','区域2','区域3','区域4','已修改的区域','区域6','区域7','区域8']);
    assert.deepEqual(saved.duties.map(row=>row.id),migrated.duties.map(row=>row.id));
    assert.equal(db.get('SELECT value FROM settings WHERE key=?','duties').value,raw);
  } finally {await app.close();db.close();}
  const reopened=createStore(path);
  try {
    assert.deepEqual(reopened.setting('weekly_duties',null),saved!);
    assert.equal(reopened.get('SELECT value FROM settings WHERE key=?','duties').value,raw);
  } finally {reopened.close();}
});

test('invalid legacy records stop migration explicitly without discarding or marking data migrated',t=>{
  for(const raw of ['not JSON','{}','[{"id":"bad","date":"2026-02-30","area":"教室","names":[]}]','[{"id":"bad","date":"2026-11-09T00:00:00+08:00","area":"教室","names":[]}]','[{"date":"2026-11-09"}]']){
    const path=legacyDatabase(t,raw);
    let opened:ReturnType<typeof createStore>|undefined;
    try {assert.throws(()=>{opened=createStore(path)},/值日.*迁移|迁移.*值日/);} finally {opened?.close();}
    const inspect=new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('SELECT value FROM settings WHERE key=?').get('duties')?.value,raw);
      assert.equal(inspect.prepare('SELECT value FROM settings WHERE key=?').get('weekly_duties'),undefined);
      assert.equal(inspect.prepare('SELECT version FROM migrations WHERE version=5').get(),undefined);
    } finally {inspect.close();}
  }
});
