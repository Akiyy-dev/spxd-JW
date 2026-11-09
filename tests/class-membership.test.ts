import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import {buildApp} from '../server/app.ts';
import {createUser, publicUser} from '../server/auth.ts';
import {createStore} from '../server/db.ts';
import type {StorageAdapter} from '../server/files.ts';

const password = 'Initial-Class2026!';
async function fixture(t: TestContext, storage?: StorageAdapter) {
  const db = createStore(), app = await buildApp({db, storage});
  t.after(async () => { await app.close(); db.close(); });
  async function login(username: string) {
    const response = await app.inject({method:'POST',url:'/api/auth/login',payload:{username,password}});
    assert.equal(response.statusCode, 200, response.body);
    return {[response.cookies[0].name]:response.cookies[0].value};
  }
  const admin = createUser(db,{username:'admin',name:'Admin',role:'super_admin',password,mustChangePassword:false});
  const cookies = await login('admin');
  async function edit(user: typeof admin, changes: object) {
    const response = await app.inject({method:'PUT',url:'/api/users/'+user.id,cookies,
      payload:{name:user.name,role:user.role,active:user.active,financeManage:user.financeManage,version:user.version,...changes}});
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  async function publish(kind = 'homework') {
    const response = await app.inject({method:'POST',url:'/api/'+kind,cookies,payload:{title:'班级任务',status:'published'}});
    assert.equal(response.statusCode, 201, response.body);
    return {task:response.json(),path:'/api/'+kind+'/'+response.json().id};
  }
  return {db,app,admin,cookies,edit,publish,login};
}

test('legacy users migrate without changing roster defaults, credentials or profiles, and migration is repeatable', () => {
  const directory=mkdtempSync(join(tmpdir(),'class-membership-')), path=join(directory,'legacy.sqlite');
  try {
    const legacy=new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,finance_manage INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,profile TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL)`);
    for(const role of ['admin','student','committee'])legacy.prepare('INSERT INTO users(id,username,name,password_hash,role,profile,created_at) VALUES(?,?,?,?,?,?,?)').run(role,role,role,'original-hash',role,'{"position":"原职务"}','2026-01-01');
    legacy.close();
    for(let attempt=0;attempt<2;attempt++) {
      const db=createStore(path);
      try {
        assert.equal(publicUser(db.get('SELECT * FROM users WHERE id=?','admin')!).inClass,false);
        for(const role of ['student','committee'])assert.equal(publicUser(db.get('SELECT * FROM users WHERE id=?',role)!).inClass,true);
        assert.equal(db.get('SELECT password_hash,profile FROM users WHERE id=?','admin').password_hash,'original-hash');
        assert.equal(db.get('SELECT profile FROM users WHERE id=?','admin').profile,'{"position":"原职务"}');
        assert.equal(db.all('SELECT * FROM migrations WHERE version=3').length,1);
      } finally {db.close();}
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('admin membership can be created, batched, edited and read on an existing session without losing privileges', async t => {
  const {app,admin,cookies,edit}=await fixture(t);
  assert.equal(admin.inClass,false);
  const enabled=await edit(admin,{inClass:true});
  assert.equal(enabled.inClass,true);
  const preserved=await edit(enabled,{name:'新名称'});
  assert.equal(preserved.inClass,true);
  assert.equal((await app.inject({url:'/api/auth/me',cookies})).json().user.inClass,true);
  assert.equal((await app.inject({url:'/api/users',cookies})).statusCode,200);
  assert.equal((await app.inject({url:'/api/finance',cookies})).json().canManage,true);
  const created=await app.inject({method:'POST',url:'/api/users',cookies,payload:{username:'new-admin',name:'新管理员',role:'admin',password,inClass:true}});
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().inClass,true);
  const batch=await app.inject({method:'POST',url:'/api/users/batch',cookies,payload:{users:[
    {username:'batch-admin',name:'批量管理员',role:'admin',password,inClass:true},
    {username:'default-admin',name:'默认管理员',role:'admin',password},
    {username:'student',name:'学生',role:'student',password,inClass:false},
  ]}});
  assert.equal(batch.statusCode,201,batch.body);
  const users=(await app.inject({url:'/api/users',cookies})).json();
  assert.equal(users.find((u:any)=>u.username==='batch-admin').inClass,true);
  assert.equal(users.find((u:any)=>u.username==='default-admin').inClass,false);
  assert.equal(users.find((u:any)=>u.username==='student').inClass,true);
  assert.equal((await edit(preserved,{inClass:false})).inClass,false);
  assert.equal((await app.inject({url:'/api/auth/me',cookies})).json().user.inClass,false);
});

for(const kind of ['homework','affairs'])test(`included administrators join ${kind} snapshots and can submit while excluded administrators cannot`,async t=>{
  const {app,admin,cookies,edit,publish}=await fixture(t);
  const old=await publish(kind);
  assert.equal(old.task.participantCount,0);
  const enabled=await edit(admin,{inClass:true});
  const current=await publish(kind);
  assert.equal(current.task.participantCount,1);
  assert.equal(current.task.myParticipantStatus,'required');
  assert.equal((await app.inject({method:'POST',url:current.path+'/submissions',cookies,payload:{text:'完成'}})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:old.path+'/submissions',cookies,payload:{text:'还未补入名单'}})).statusCode,403);
  const added=await app.inject({method:'PUT',url:old.path+'/participants',cookies,payload:{version:old.task.version,userIds:[admin.id]}});
  assert.equal(added.statusCode,200,added.body);
  const disabled=await edit(enabled,{inClass:false});
  assert.equal((await app.inject({url:old.path,cookies})).json().myParticipantStatus,'excused');
  assert.equal((await app.inject({url:current.path,cookies})).json().submittedCount,1);
  assert.equal((await app.inject({method:'POST',url:current.path+'/submissions',cookies,payload:{text:'不得再提交'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/submissions/history',cookies})).json()[0].text,'完成');
  const latest=(await app.inject({url:old.path,cookies})).json();
  assert.equal((await app.inject({method:'PUT',url:old.path+'/participants',cookies,payload:{version:latest.version,userIds:[admin.id]}})).statusCode,400);
  await edit(disabled,{inClass:true});
  assert.equal((await app.inject({url:old.path,cookies})).json().myParticipantStatus,'excused');
});

test('included administrators are class members and valid fee/payment targets',async t=>{
  const {app,admin,cookies,edit}=await fixture(t);
  assert.deepEqual((await app.inject({url:'/api/class',cookies})).json().members,[]);
  assert.deepEqual((await app.inject({url:'/api/finance/members',cookies})).json(),[]);
  const feePayload={title:'班费',amount:100,deadline:null,userIds:[admin.id]};
  assert.equal((await app.inject({method:'POST',url:'/api/finance/fees',cookies,payload:feePayload})).statusCode,400);
  await edit(admin,{inClass:true});
  assert.deepEqual((await app.inject({url:'/api/class',cookies})).json().members.map((u:any)=>u.id),[admin.id]);
  assert.deepEqual((await app.inject({url:'/api/finance/members',cookies})).json().map((u:any)=>u.id),[admin.id]);
  const fee=await app.inject({method:'POST',url:'/api/finance/fees',cookies,payload:feePayload});
  assert.equal(fee.statusCode,200,fee.body);
  const payment=await app.inject({method:'POST',url:'/api/finance/payments',cookies,payload:{feeId:fee.json().id,userId:admin.id,amount:100,date:'2026-11-09',description:'已缴',receiptIds:[],idempotencyKey:randomUUID()}});
  assert.equal(payment.statusCode,200,payment.body);
  assert.equal(payment.json().userId,admin.id);
});

test('included administrators can upload, confirm and submit their own task attachments; removal revokes upload access',async t=>{
  const {app,admin,cookies,edit,publish}=await fixture(t,{
    configured:true,uploadUrl:async()=>({url:'https://storage.test/upload',headers:{}}),head:async()=>({size:4,mime:'text/plain'}),readHead:async()=>Buffer.from('text'),downloadUrl:async()=> 'https://storage.test/download',remove:async()=>{},put:async()=>{},
  });
  const enabled=await edit(admin,{inClass:true});
  const {path,task}=await publish();
  const payload={name:'work.txt',size:4,mime:'text/plain',purpose:'submission',entityId:task.id};
  const upload=await app.inject({method:'POST',url:'/api/files/upload',cookies,payload});
  assert.equal(upload.statusCode,200,upload.body);
  const fileId=upload.json().fileId;
  assert.equal((await app.inject({method:'POST',url:'/api/files/'+fileId+'/confirm',cookies})).statusCode,200);
  const submitted=await app.inject({method:'POST',url:path+'/submissions',cookies,payload:{attachments:[fileId]}});
  assert.equal(submitted.statusCode,201,submitted.body);
  await edit(enabled,{inClass:false});
  assert.equal((await app.inject({method:'POST',url:'/api/files/upload',cookies,payload})).statusCode,403);
});

test('role changes preserve student membership only when the new administrator is explicitly included',async t=>{
  const {app,db,cookies,edit,publish}=await fixture(t);
  const student=createUser(db,{username:'student',name:'学生',role:'student',password,mustChangePassword:false});
  const {path}=await publish();
  const promoted=await edit(student,{role:'admin',inClass:true});
  assert.equal(promoted.inClass,true);
  assert.equal((await app.inject({url:path+'/participants',cookies})).json()[0].status,'required');
  const demoted=await edit(promoted,{role:'student',inClass:false});
  assert.equal(demoted.inClass,true);
  const promotedWithoutOptIn=await edit(demoted,{role:'admin'});
  assert.equal(promotedWithoutOptIn.inClass,false);
  assert.equal((await app.inject({url:path+'/participants',cookies})).json()[0].status,'excused');
});
