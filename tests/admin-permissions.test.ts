import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../server/app.ts';
import {createUser,hashPassword} from '../server/auth.ts';
import {createStore} from '../server/db.ts';
import {PERMISSION_KEYS, effectivePermissions, type Permission} from '../shared/permissions.ts';
const password='Initial-Pass2026!';
async function fixture(t:TestContext) {
  const db=createStore(),app=await buildApp({db});
  t.after(async()=>{await app.close();db.close();});
  const login=async(username:string)=>{const res=await app.inject({method:'POST',url:'/api/auth/login',payload:{username,password}});assert.equal(res.statusCode,200,res.body);return {[res.cookies[0].name]:res.cookies[0].value};};
  const user=(username:string,role:'admin'|'super_admin'|'committee'|'student'='admin',permissions:Permission[]=[])=>createUser(db,{username,name:username,role,permissions,password,mustChangePassword:false});
  return {db,app,login,user};
}

test('new admins fail closed and independent grants change existing sessions immediately',async t=>{
  const {app,login,user}=await fixture(t);
  const empty=user('empty');user('reader','admin',['accounts.read']);user('root','super_admin');
  const cookies=await login('empty'),reader=await login('reader'),root=await login('root');
  assert.equal((await app.inject({url:'/api/users',cookies})).statusCode,403);
  assert.deepEqual((await app.inject({url:'/api/users',cookies:reader})).json(),[]);
  const grant=await app.inject({method:'PUT',url:`/api/users/${empty.id}/permissions`,cookies:root,payload:{permissions:['accounts.read'],version:1}});
  assert.equal(grant.statusCode,200,grant.body);
  assert.equal((await app.inject({url:'/api/users',cookies})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${empty.id}/permissions`,cookies:root,payload:{permissions:[],version:1}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${empty.id}/permissions`,cookies:root,payload:{permissions:[],version:2}})).statusCode,200);
  assert.equal((await app.inject({url:'/api/users',cookies})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${empty.id}/permissions`,cookies:root,payload:{permissions:['finance.entries.create'],version:3}})).statusCode,400);
});

test('restricted accounts permissions cannot acquire committee capabilities in create, batch, reset, enable or role changes',async t=>{
  const {app,db,login,user}=await fixture(t);
  user('restricted','admin',['accounts.read','accounts.create','accounts.edit','accounts.roles','accounts.status','accounts.resetPassword']);
  const student=user('student','student'),committee=user('committee','committee'),root=user('root','super_admin');
  const cookies=await login('restricted');
  for(const role of ['admin','super_admin','committee']){
    const payload={username:`new-${role}`,name:'new',role,password};
    assert.equal((await app.inject({method:'POST',url:'/api/users',cookies,payload})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/users/batch',cookies,payload:{users:[{...payload,username:'batch-student',role:'student'},payload]}})).statusCode,403);
    assert.equal(db.get('SELECT id FROM users WHERE username=?','batch-student'),undefined);
  }
  assert.equal((await app.inject({method:'POST',url:`/api/users/${committee.id}/reset-password`,cookies,payload:{password,version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/api/users/${root.id}/reset-password`,cookies,payload:{password,version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${student.id}`,cookies,payload:{name:'student',role:'committee',active:true,financeManage:false,version:1}})).statusCode,403);
  db.run('UPDATE users SET active=0 WHERE id=?',committee.id);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${committee.id}`,cookies,payload:{name:'committee',role:'committee',active:true,financeManage:false,version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/api/users/${student.id}/reset-password`,cookies,payload:{password:'New-Pass2026!',version:1}})).statusCode,200);
});

test('committee subset permits ordinary committee management but rejects financial delegation, all fields enforce their own grants',async t=>{
  const {app,db,login,user}=await fixture(t);
  const permissions=[...effectivePermissions({role:'committee'}),'accounts.read','accounts.create','accounts.roles','accounts.resetPassword'] as Permission[];
  user('manager','admin',permissions);const student=user('student','student');user('root','super_admin');
  const financial=createUser(db,{username:'financial',name:'financial',role:'committee',financeManage:true,password,mustChangePassword:false});
  const cookies=await login('manager');
  assert.equal((await app.inject({method:'POST',url:'/api/users',cookies,payload:{username:'committee',name:'committee',role:'committee',password}})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/users',cookies,payload:{username:'finance2',name:'finance2',role:'committee',financeManage:true,password}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/api/users/${financial.id}/reset-password`,cookies,payload:{password,version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${student.id}`,cookies,payload:{name:'renamed',role:'committee',active:true,financeManage:false,version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${student.id}`,cookies,payload:{name:'student',role:'committee',active:true,financeManage:false,version:1}})).statusCode,200);
});

test('Admin username rename checks uniqueness, revokes sessions, keeps associations and never exposes secrets',async t=>{
  const {app,db,login,user}=await fixture(t);
  const root=user('root','super_admin'),target=user('target','student');user('duplicate','student');
  const rootCookies=await login('root'),targetCookies=await login('target');
  const payload={username:'duplicate',name:target.name,role:target.role,active:true,financeManage:false,version:1};
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${target.id}`,cookies:rootCookies,payload})).statusCode,409);
  const renamed=await app.inject({method:'PUT',url:`/api/users/${target.id}`,cookies:rootCookies,payload:{...payload,username:'renamed'}});
  assert.equal(renamed.statusCode,200,renamed.body);assert.equal(renamed.json().id,target.id);
  assert.deepEqual((await app.inject({url:'/api/auth/me',cookies:targetCookies})).json(),{user:null});
  assert.equal((await login('renamed'))!==undefined,true);
  const hash=db.get('SELECT password_hash FROM users WHERE id=?',target.id).password_hash;
  assert.equal(renamed.body.includes(hash),false);
  assert.equal(JSON.stringify(db.all('SELECT details FROM audit')).includes(hash),false);
  assert.equal((await app.inject({method:'POST',url:`/api/users/${target.id}/reset-password`,cookies:rootCookies,payload:{password:'Reset-Secure2026!',version:1}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:`/api/users/${target.id}/reset-password`,cookies:rootCookies,payload:{password:'Reset-Secure2026!',version:2}})).statusCode,200);
  assert.equal(JSON.stringify(db.all('SELECT details FROM audit')).includes('Reset-Secure2026!'),false);
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${root.id}`,cookies:rootCookies,payload:{username:'root2',name:root.name,role:root.role,active:true,financeManage:false,version:1}})).statusCode,200);
  assert.deepEqual((await app.inject({url:'/api/auth/me',cookies:rootCookies})).json(),{user:null});
});

test('last active Admin is protected and role changes clear grants rather than restoring them',async t=>{
  const {app,login,user}=await fixture(t);const root=user('root','super_admin'),admin=user('admin','admin',['finance.read']);const cookies=await login('root');
  for(const change of [{active:false,role:'super_admin'},{active:true,role:'admin'}])assert.equal((await app.inject({method:'PUT',url:`/api/users/${root.id}`,cookies,payload:{...change,name:'root',financeManage:false,version:1}})).statusCode,409);
  const update=(role:string,version:number)=>app.inject({method:'PUT',url:`/api/users/${admin.id}`,cookies,payload:{name:'admin',role,active:true,financeManage:false,version}});
  assert.equal((await update('student',1)).statusCode,200);
  const promoted=await update('admin',2);assert.equal(promoted.statusCode,200);assert.deepEqual(promoted.json().permissions,[]);
});

test('concurrent Admin demotions leave exactly one enabled Admin',async t=>{
  const {app,db,login,user}=await fixture(t),first=user('first','super_admin'),second=user('second','super_admin');
  const firstCookies=await login('first'),secondCookies=await login('second');
  const results=await Promise.all([[first,firstCookies],[second,secondCookies]].map(([target,cookies])=>app.inject({method:'PUT',url:`/api/users/${(target as typeof first).id}`,cookies:cookies as Record<string,string>,payload:{name:(target as typeof first).name,role:'admin',active:true,financeManage:false,version:1}})));
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal(db.get("SELECT count(*) n FROM users WHERE role='super_admin' AND active=1").n,1);
});

test('account mutations re-read actor grants and target protection inside the transaction',async t=>{
  const {app,db,login,user}=await fixture(t);
  const manager=user('manager','admin',['accounts.read','accounts.create','accounts.resetPassword']);const target=user('target','student');
  // A pre-handler models a grant/target update after the authentication snapshot.
  app.addHook('preHandler',async request=>{
    if(request.headers['x-revoke']==='1')db.run("UPDATE users SET permissions='[]' WHERE id=?",manager.id);
    if(request.headers['x-protect']==='1')db.run("UPDATE users SET role='admin',version=version+1 WHERE id=?",target.id);
  });
  const cookies=await login('manager');
  const reset=await app.inject({method:'POST',url:`/api/users/${target.id}/reset-password`,cookies,headers:{'x-protect':'1'},payload:{password:'Reset-Pass2026!',version:1}});
  assert.equal(reset.statusCode,403);
  const create=await app.inject({method:'POST',url:'/api/users',cookies,headers:{'x-revoke':'1'},payload:{username:'new',name:'new',role:'student',password}});
  assert.equal(create.statusCode,403);assert.equal(db.get('SELECT id FROM users WHERE username=?','new'),undefined);
});

test('self password and avatar updates reject a disabled actor after the authentication snapshot',async t=>{
  const {app,db,login,user}=await fixture(t);const student=user('student','student');
  app.addHook('preHandler',async request=>{if(request.headers['x-disable']==='1')db.run('UPDATE users SET active=0 WHERE id=?',student.id);});
  const cookies=await login('student'),before=db.get('SELECT password_hash FROM users WHERE id=?',student.id).password_hash;
  assert.equal((await app.inject({method:'POST',url:'/api/auth/password',cookies,headers:{'x-disable':'1'},payload:{currentPassword:password,newPassword:'Changed-Pass2026!'}})).statusCode,401);
  assert.equal(db.get('SELECT password_hash FROM users WHERE id=?',student.id).password_hash,before);
  db.run('UPDATE users SET active=1 WHERE id=?',student.id);
  assert.equal((await app.inject({method:'PUT',url:'/api/auth/avatar',cookies,headers:{'x-disable':'1'},payload:{avatarFileId:null,version:1}})).statusCode,401);
  assert.equal(db.get('SELECT version FROM users WHERE id=?',student.id).version,1);
});

for(const operation of [
  {label:'class settings',method:'PUT' as const,url:'/api/class',payload:{version:1,config:{name:'Unauthorized change'}},table:'settings'},
  {label:'homework',method:'POST' as const,url:'/api/homework',payload:{title:'Unauthorized task'},table:'tasks'},
  {label:'affairs',method:'POST' as const,url:'/api/affairs',payload:{title:'Unauthorized task'},table:'tasks'},
  {label:'finance fees',method:'POST' as const,url:'/api/finance/fees',payload:{title:'Unauthorized fee',amount:100,deadline:null,userIds:[]},table:'fees'},
  {label:'timetable templates',method:'POST' as const,url:'/api/timetable/templates',payload:{name:'Unauthorized template',selectionVersion:0,periods:[{id:1,label:'First',start:'08:00',end:'08:45'}],courses:[]},table:'timetable_templates'},
])test(`${operation.label} authorization reflects grant, role, status and session changes while the body is being parsed`,async t=>{
  const {app,db,login,user}=await fixture(t),actor=user('actor','admin',PERMISSION_KEYS);
  // preValidation runs after request-body parsing and before authentication must
  // make its final snapshot. This models an administrator revoking access while
  // a slow/chunked request body was still in flight, without timing flakiness.
  app.addHook('preValidation',async request=>{
    switch(request.headers['x-auth-change']){
      case 'grants':db.run("UPDATE users SET permissions='[]' WHERE id=?",actor.id);break;
      case 'role':db.run("UPDATE users SET role='student' WHERE id=?",actor.id);break;
      case 'disabled':db.run('UPDATE users SET active=0 WHERE id=?',actor.id);break;
      case 'password':db.run('UPDATE users SET must_change_password=1 WHERE id=?',actor.id);break;
      case 'session':db.run('DELETE FROM sessions WHERE user_id=?',actor.id);break;
    }
  });
  for(const change of ['grants','role','disabled','password','session']){
    db.run("UPDATE users SET role='admin',active=1,must_change_password=0,permissions=? WHERE id=?",JSON.stringify(PERMISSION_KEYS),actor.id);
    const cookies=await login('actor');
    const result=await app.inject({method:operation.method,url:operation.url,payload:operation.payload,cookies,headers:{'x-auth-change':change}});
    assert.equal(result.statusCode,change==='disabled'||change==='session'?401:403,`${change}: ${result.body}`);
    assert.equal(db.get(`SELECT count(*) n FROM ${operation.table}`).n,0);
    assert.equal(db.get('SELECT count(*) n FROM audit').n,0);
  }
});

test('legacy migration preserves user identifiers, profile, hash, membership, sessions and foreign keys with explicit grants',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'permissions-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'legacy.sqlite'),old=new DatabaseSync(path),hash=hashPassword(password);
  old.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);INSERT INTO migrations VALUES(3,'old');
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','committee','student')),finance_manage INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,profile TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,in_class INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);`);
  old.prepare('INSERT INTO users(id,username,name,password_hash,role,profile,created_at,in_class) VALUES(?,?,?,?,?,?,?,?)').run('stable','Akiyy','Original',hash,'admin','{"avatarFileId":"avatar-stable"}','old',1);
  old.prepare('INSERT INTO sessions VALUES(?,?,?)').run('token','stable','2099-01-01');old.close();
  let db=createStore(path);const row=db.get('SELECT * FROM users WHERE id=?','stable');
  assert.equal(row.password_hash,hash);assert.equal(row.profile,'{"avatarFileId":"avatar-stable"}');assert.equal(row.in_class,1);assert.equal(row.role,'admin');
  assert.deepEqual(new Set(JSON.parse(row.permissions)),new Set(PERMISSION_KEYS));assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
  assert.equal(db.get('SELECT user_id FROM sessions').user_id,'stable');
  db.run("UPDATE users SET permissions='[]' WHERE id='stable'");db.close();db=createStore(path);
  assert.equal(db.get('SELECT permissions FROM users').permissions,'[]');db.close();
});

test('bootstrap promotes only intended enabled existing admin and safely repeats without changing credentials',async t=>{
  const {promoteAdmin}=await import('../scripts/promote-admin.ts');const {db,user}=await fixture(t);
  assert.throws(()=>promoteAdmin(db,'Akiyy'));
  user('student','student');assert.throws(()=>promoteAdmin(db,'student'));assert.throws(()=>promoteAdmin(db,''));
  const aki=user('Akiyy'),other=user('other');const before=db.get('SELECT * FROM users WHERE id=?',aki.id);
  db.run('UPDATE users SET in_class=1 WHERE id=?',aki.id);db.run('UPDATE users SET active=0 WHERE id=?',aki.id);assert.throws(()=>promoteAdmin(db,'Akiyy'));
  db.run('UPDATE users SET active=1 WHERE id=?',aki.id);promoteAdmin(db,'Akiyy');promoteAdmin(db,'Akiyy');
  const after=db.get('SELECT * FROM users WHERE id=?',aki.id);assert.equal(after.role,'super_admin');assert.equal(after.password_hash,before.password_hash);assert.equal(after.in_class,1);
  assert.equal(db.get('SELECT role FROM users WHERE id=?',other.id).role,'admin');assert.throws(()=>promoteAdmin(db,'other'));
  assert.equal(db.get("SELECT count(*) n FROM audit WHERE action='user.bootstrap-admin'").n,1);
});
