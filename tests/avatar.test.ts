import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {buildApp} from '../server/app.ts';
import {createUser} from '../server/auth.ts';
import {createStore} from '../server/db.ts';
import {cleanupFiles,type StorageAdapter} from '../server/files.ts';

const password='Avatar-Testing123!';
const animatedGif=Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBDwABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7','base64');
const png=Buffer.from('89504e470d0a1a0a00000000','hex');
async function fixture(t:TestContext) {
  const db=createStore(), objects=new Map<string,{bytes:Buffer,mime:string}>(),removed:string[]=[];
  const storage:StorageAdapter={configured:true,
    uploadUrl:async key=>({url:'https://storage.test/'+key,headers:{}}),
    head:async key=>({size:objects.get(key)!.bytes.length,mime:objects.get(key)!.mime}),
    readHead:async key=>objects.get(key)!.bytes.subarray(0,1024),read:async key=>objects.get(key)!.bytes,
    downloadUrl:async()=> 'https://storage.test/download',put:async()=>{},remove:async key=>{removed.push(key);objects.delete(key)},
  };
  const app=await buildApp({db,storage});t.after(async()=>{await app.close();db.close()});
  const student=createUser(db,{username:'student',name:'同学',password,role:'student',mustChangePassword:false});
  const other=createUser(db,{username:'other',name:'其他同学',password,role:'student',mustChangePassword:false});
  const admin=createUser(db,{username:'admin',name:'管理员',password,role:'admin',mustChangePassword:false});
  const fresh=createUser(db,{username:'fresh',name:'新同学',password,role:'student'});
  const cookies:Record<string,Record<string,string>>={};
  for(const u of [student,other,admin,fresh]){const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:u.username,password}});assert.equal(login.statusCode,200);cookies[u.id]={[login.cookies[0].name]:login.cookies[0].value};}
  async function upload(who=student,target=who.id,bytes=animatedGif,name='头像.gif',mime='image/gif'){
    const r=await app.inject({method:'POST',url:'/api/files/upload',cookies:cookies[who.id],payload:{purpose:'avatar',entityId:target,name,mime,size:bytes.length}});
    assert.equal(r.statusCode,200,r.body);const fileId=r.json().fileId;const row=db.get('SELECT * FROM files WHERE id=?',fileId);objects.set(row.object_key,{bytes,mime});return fileId;
  }
  async function confirm(id:string,who=student){return app.inject({method:'POST',url:'/api/files/'+id+'/confirm',cookies:cookies[who.id]})}
  async function save(avatarFileId:string|null,who=student,version?:number,extra={}) {return app.inject({method:'PUT',url:'/api/auth/avatar',cookies:cookies[who.id],payload:{avatarFileId,version:version??db.get('SELECT version FROM users WHERE id=?',who.id).version,...extra}})}
  return{db,app,student,other,admin,fresh,cookies,objects,storage,removed,upload,confirm,save};
}

test('activated students upload and save animated avatars without changing animation bytes or account identity',async t=>{
  const f=await fixture(t),{app,student,cookies,db}=f;
  const id=await f.upload();assert.equal((await f.confirm(id)).statusCode,200);
  const result=await f.save(id,student,student.version,{role:'admin',name:'伪造姓名',financeManage:true});
  assert.equal(result.statusCode,200,result.body);const user=result.json().user;
  assert.equal(user.avatarFileId,id);assert.equal(user.version,student.version+1);assert.equal(user.role,'student');assert.equal(user.name,student.name);assert.equal(user.financeManage,false);
  assert.equal((await app.inject({url:'/api/auth/me',cookies:cookies[student.id]})).json().user.avatarFileId,id);
  assert.equal((await app.inject({url:'/api/class',cookies:cookies[student.id]})).json().members.find((u:any)=>u.id===student.id).avatarFileId,id);
  const preview=await app.inject({url:'/api/files/'+id+'/preview',cookies:cookies[student.id]});
  assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.headers['content-type'],'image/gif');assert.deepEqual(preview.rawPayload,animatedGif);
  assert.equal(db.get('SELECT expires_at FROM files WHERE id=?',id).expires_at,null);
});

test('staged avatars are private to uploaders; published avatars require activation and a session',async t=>{
  const f=await fixture(t),id=await f.upload();assert.equal((await f.confirm(id)).statusCode,200);
  const path='/api/files/'+id+'/preview';
  assert.equal((await f.app.inject({url:path,cookies:f.cookies[f.student.id]})).statusCode,200);
  for(const who of [f.other,f.admin])assert.equal((await f.app.inject({url:path,cookies:f.cookies[who.id]})).statusCode,403);
  assert.equal((await f.save(id)).statusCode,200);
  assert.equal((await f.app.inject({url:path,cookies:f.cookies[f.other.id]})).statusCode,200);
  assert.equal((await f.app.inject({url:path})).statusCode,401);
  assert.equal((await f.app.inject({url:path,cookies:f.cookies[f.fresh.id]})).statusCode,403);
  assert.equal((await f.app.inject({url:'/api/public/photo/'+id})).statusCode,404);
});

test('self avatar uploads and saves cannot target another user, use unconfirmed files or bypass initial password change',async t=>{
  const f=await fixture(t),{app,student,other,fresh,cookies}=f;
  const request={name:'a.gif',size:animatedGif.length,mime:'image/gif',purpose:'avatar',entityId:other.id};
  assert.equal((await app.inject({method:'POST',url:'/api/files/upload',cookies:cookies[student.id],payload:request})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/files/upload',cookies:cookies[fresh.id],payload:{...request,entityId:fresh.id}})).statusCode,403);
  assert.equal((await f.save(null,fresh)).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/auth/avatar',payload:{avatarFileId:null,version:1}})).statusCode,401);
  const pending=await f.upload();assert.equal((await f.save(pending)).statusCode,400);
  const theirs=await f.upload(other);assert.equal((await f.confirm(theirs,other)).statusCode,200);
  assert.equal((await f.save(theirs)).statusCode,403);
  assert.equal((await f.save(theirs,f.admin)).statusCode,403);
  const own=await f.upload();assert.equal((await f.confirm(own)).statusCode,200);
  assert.equal((await f.save(own,student,student.version,{userId:other.id})).statusCode,200);
  assert.equal((await app.inject({url:'/api/auth/me',cookies:cookies[other.id]})).json().user.avatarFileId,null);
});

test('avatar formats and 5 MiB limits are enforced by the server and confirmation detects forged content',async t=>{
  const f=await fixture(t),{app,admin,cookies}=f;
  const base={purpose:'avatar',entityId:admin.id,name:'avatar.png',mime:'image/png',size:5*1024*1024};
  const accepted=await app.inject({method:'POST',url:'/api/files/upload',cookies:cookies[admin.id],payload:base});
  assert.equal(accepted.statusCode,200,accepted.body);
  for(const changes of [{size:base.size+1},{size:0},{name:'avatar.svg',mime:'image/svg+xml'},{name:'avatar.pdf',mime:'application/pdf'}]){
    assert.equal((await app.inject({method:'POST',url:'/api/files/upload',cookies:cookies[admin.id],payload:{...base,...changes}})).statusCode,400);
  }
  const forged=await f.upload(f.student,f.student.id,Buffer.from('<html>fake gif</html>'));
  assert.equal((await f.confirm(forged)).statusCode,400);
  const wrongMime=await f.upload();const row=f.db.get('SELECT * FROM files WHERE id=?',wrongMime);f.objects.get(row.object_key)!.mime='text/html';
  assert.equal((await f.confirm(wrongMime)).statusCode,400);
});

test('avatar replacement and removal revoke old access and make old objects eligible for cleanup',async t=>{
  const f=await fixture(t),first=await f.upload();assert.equal((await f.confirm(first)).statusCode,200);assert.equal((await f.save(first)).statusCode,200);
  const second=await f.upload(f.student,f.student.id,png,'avatar.png','image/png');assert.equal((await f.confirm(second)).statusCode,200);assert.equal((await f.save(second)).statusCode,200);
  assert.equal((await f.app.inject({url:'/api/files/'+first+'/preview',cookies:f.cookies[f.student.id]})).statusCode,403);
  assert.equal((await f.save(first)).statusCode,400);
  assert.equal(await cleanupFiles(f.db,f.storage),1);
  assert.equal((await f.save(null)).json().user.avatarFileId,null);
  assert.equal((await f.app.inject({url:'/api/files/'+second+'/preview',cookies:f.cookies[f.other.id]})).statusCode,403);
  assert.equal(await cleanupFiles(f.db,f.storage),1);assert.equal(f.removed.length,2);
});

test('personal and manager avatar updates reject stale versions in both directions',async t=>{
  const f=await fixture(t),{app,student,admin,cookies}=f;
  const original=(await app.inject({url:'/api/class',cookies:cookies[admin.id]})).json();
  const id=await f.upload();assert.equal((await f.confirm(id)).statusCode,200);assert.equal((await f.save(id)).statusCode,200);
  assert.equal((await f.save(null,student,student.version)).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:'/api/class',cookies:cookies[admin.id],payload:{version:original.version,members:[{id:student.id,avatarFileId:''}]}})).statusCode,409);
  const current=(await app.inject({url:'/api/class',cookies:cookies[admin.id]})).json();
  const me=(await app.inject({url:'/api/auth/me',cookies:cookies[student.id]})).json().user;
  const removed=await app.inject({method:'PUT',url:'/api/class',cookies:cookies[admin.id],payload:{version:current.version,members:[{id:student.id,avatarFileId:''}]}});
  assert.equal(removed.statusCode,200,removed.body);
  assert.equal((await f.save(id,student,me.version)).statusCode,409);
  assert.equal((await app.inject({url:'/api/auth/me',cookies:cookies[student.id]})).json().user.avatarFileId,null);
});

test('administrators outside the class roster can upload their own avatars and managers retain member editing',async t=>{
  const f=await fixture(t),{app,admin,student,cookies}=f;
  assert.equal(admin.inClass,false);
  const personal=await f.upload(admin);assert.equal((await f.confirm(personal,admin)).statusCode,200);assert.equal((await f.save(personal,admin)).statusCode,200);
  const managed=await f.upload(admin,student.id);assert.equal((await f.confirm(managed,admin)).statusCode,200);
  const data=(await app.inject({url:'/api/class',cookies:cookies[admin.id]})).json();
  const saved=await app.inject({method:'PUT',url:'/api/class',cookies:cookies[admin.id],payload:{version:data.version,members:[{id:student.id,avatarFileId:managed}]}});
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await app.inject({url:'/api/auth/me',cookies:cookies[student.id]})).json().user.avatarFileId,managed);
  assert.equal((await f.save(managed,student)).statusCode,200,'user may preserve the currently assigned avatar even if a manager uploaded it');
});
