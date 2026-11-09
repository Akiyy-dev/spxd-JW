import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {buildApp} from '../server/app.ts';
import {createUser} from '../server/auth.ts';
import {createStore} from '../server/db.ts';
import type {StorageAdapter} from '../server/files.ts';
import {PERMISSION_KEYS, type Permission} from '../shared/permissions.ts';

async function fixture(t: TestContext, storage?: StorageAdapter) {
  const db = createStore(), app = await buildApp({db,storage});
  t.after(async () => {await app.close(); db.close();});
  let number = 0;
  async function account(permissions: Permission[] = [], role: 'admin'|'student'|'committee' = 'admin', inClass = false) {
    const username = `task-user-${++number}`, password = 'Task-Tests2026!';
    const user = createUser(db, {username,name:username,password,role,permissions,inClass,mustChangePassword:false});
    const login = await app.inject({method:'POST',url:'/api/auth/login',payload:{username,password}});
    assert.equal(login.statusCode, 200, login.body);
    return {user,cookies:{[login.cookies[0].name]:login.cookies[0].value}};
  }
  const committee = await account([], 'committee');
  async function task(kind: 'homework'|'affairs' = 'homework', status = 'published') {
    const response = await app.inject({method:'POST',url:'/api/'+kind,cookies:committee.cookies,payload:{title:'Private task',status}});
    assert.equal(response.statusCode, 201, response.body);
    return {task:response.json(),url:`/api/${kind}/${response.json().id}`};
  }
  return {app,db,account,committee,task};
}

test('empty-grant admins cannot mutate tasks and creation never implies publication or another module', async t => {
  const {app,account} = await fixture(t);
  const empty = await account(), creator = await account(['homework.create']);
  for (const [cookies,url,payload] of [
    [empty.cookies,'/api/homework',{title:'Denied'}],
    [creator.cookies,'/api/homework',{title:'Denied',status:'published'}],
    [creator.cookies,'/api/affairs',{title:'Denied'}],
  ] as const) assert.equal((await app.inject({method:'POST',url,cookies,payload})).statusCode, 403);
  const created = await app.inject({method:'POST',url:'/api/homework',cookies:creator.cookies,payload:{title:'Draft'}});
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'draft');
  const publisher = await account(['homework.create','homework.drafts.read','homework.publish']);
  assert.equal((await app.inject({method:'POST',url:'/api/homework',cookies:publisher.cookies,payload:{title:'Published',status:'published'}})).statusCode,201);
});

test('draft and private submission reads are separate from task writing and preserve own student records', async t => {
  const {app,account,task} = await fixture(t);
  const student = await account([], 'student'), empty = await account();
  const editor = await account(['affairs.drafts.read','affairs.edit']);
  const draft = await task('affairs','draft'), published = await task('affairs');
  assert.equal((await app.inject({method:'POST',url:published.url+'/submissions',cookies:student.cookies,payload:{text:'Secret answer'}})).statusCode,201);
  assert.equal((await app.inject({url:draft.url,cookies:empty.cookies})).statusCode,404);
  assert.deepEqual((await app.inject({url:'/api/affairs',cookies:empty.cookies})).json().map((item:{id:string})=>item.id), [published.task.id]);
  const edited = await app.inject({url:published.url,cookies:editor.cookies});
  assert.equal(edited.json().hasSubmissions,true);
  assert.equal(edited.json().mySubmission,null);
  assert.equal((await app.inject({url:published.url+'/submissions',cookies:editor.cookies})).statusCode,403);
  assert.equal((await app.inject({url:published.url+'/participants',cookies:editor.cookies})).statusCode,403);
  assert.equal((await app.inject({url:published.url+'/submissions',cookies:student.cookies})).json()[0].text,'Secret answer');
  assert.equal((await app.inject({url:published.url,cookies:empty.cookies})).json().hasSubmissions,undefined);
});

for(const kind of ['homework','affairs'] as const)test(`${kind} aggregate counts require their separate read grants while editors receive only locking metadata`,async t=>{
  const {app,account,task}=await fixture(t);
  const student=await account([],'student'),empty=await account(),editor=await account([`${kind}.drafts.read`,`${kind}.edit`]);
  const roster=await account([`${kind}.participants.read`]),submissions=await account([`${kind}.submissions.read`]);
  const published=await task(kind);
  assert.equal((await app.inject({method:'POST',url:published.url+'/submissions',cookies:student.cookies,payload:{text:'Own answer'}})).statusCode,201);
  for(const [actor,expectedParticipants,expectedSubmissions,expectedLock] of [
    [student,undefined,undefined,undefined],[empty,undefined,undefined,undefined],[editor,undefined,undefined,true],
    [roster,2,undefined,undefined],[submissions,undefined,1,undefined],
  ] as const){
    const response=await app.inject({url:published.url,cookies:actor.cookies});assert.equal(response.statusCode,200);
    const item=response.json();assert.equal(item.participantCount,expectedParticipants);assert.equal(item.submittedCount,expectedSubmissions);assert.equal(item.hasSubmissions,expectedLock);
    const list=(await app.inject({url:'/api/'+kind,cookies:actor.cookies})).json();
    assert.equal(list[0].participantCount,expectedParticipants);assert.equal(list[0].submittedCount,expectedSubmissions);
  }
});

test('task lifecycle authorization follows actual status and content changes', async t => {
  const {app,account,task} = await fixture(t);
  const editor = await account(['homework.drafts.read','homework.edit']);
  const publisher = await account(['homework.drafts.read','homework.publish']);
  const withdrawer = await account(['homework.withdraw']);
  const archiver = await account(['homework.archive']);
  const published = await task(), draft = await task('homework','draft');
  const change = (url:string,cookies:Record<string,string>,version:number,payload:object)=>app.inject({method:'PUT',url,cookies,payload:{version,...payload}});
  assert.equal((await change(published.url,editor.cookies,1,{title:'Edit published'})).statusCode,403);
  assert.equal((await change(draft.url,publisher.cookies,1,{title:'Changed on publish',status:'published'})).statusCode,403);
  assert.equal((await change(published.url,withdrawer.cookies,1,{title:'Changed on withdraw',status:'draft'})).statusCode,403);
  assert.equal((await change(published.url,archiver.cookies,1,{title:'Changed on archive',status:'archived'})).statusCode,403);
  const publishedDraft = await change(draft.url,publisher.cookies,1,{title:draft.task.title,status:'published'});
  assert.equal(publishedDraft.statusCode,200,publishedDraft.body);
  const archived = await change(published.url,archiver.cookies,1,{title:published.task.title,status:'archived'});
  assert.equal(archived.statusCode,200,archived.body);
  assert.equal((await change(published.url,publisher.cookies,archived.json().version,{status:'published'})).statusCode,200);
  const withdrawn = await change(draft.url,withdrawer.cookies,publishedDraft.json().version,{status:'draft'});
  assert.equal(withdrawn.statusCode,200,withdrawn.body);
  assert.equal((await change(draft.url,editor.cookies,withdrawn.json().version,{title:'Draft edit'})).statusCode,200);
});

test('roster access, roster writes and exports require their individual read dependencies', async t => {
  const {app,db,account,task} = await fixture(t);
  const viewer = await account(['homework.participants.read']);
  const reader = await account(['homework.submissions.read']);
  const malformedExcel = await account(['homework.export','homework.submissions.read','homework.participants.read']);
  db.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(['homework.export','homework.submissions.read']),malformedExcel.user.id);
  const zipper = await account(['homework.exportFiles','homework.submissions.read']);
  const published = await task();
  assert.equal((await app.inject({url:published.url+'/participants',cookies:viewer.cookies})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:published.url+'/participants',cookies:viewer.cookies,payload:{version:1,userIds:[]}})).statusCode,403);
  assert.equal((await app.inject({url:published.url+'/submissions',cookies:reader.cookies})).statusCode,200);
  for (const cookies of [reader.cookies,malformedExcel.cookies])
    assert.equal((await app.inject({method:'POST',url:published.url+'/export',cookies})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:published.url+'/export-files',cookies:reader.cookies,payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:published.url+'/export-files',cookies:zipper.cookies,payload:{}})).statusCode,400);
});

test('ungranted elevated members can submit only with membership and an explicit participant slot', async t => {
  const {app,account,task,committee} = await fixture(t);
  const member = await account([], 'admin', true), excluded = await account();
  const published = await task();
  const later = await account([], 'admin', true);
  assert.equal((await app.inject({method:'POST',url:published.url+'/submissions',cookies:member.cookies,payload:{text:'Own answer'}})).statusCode,201);
  for (const cookies of [excluded.cookies,later.cookies])
    assert.equal((await app.inject({method:'POST',url:published.url+'/submissions',cookies,payload:{text:'Denied'}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:published.url+'/participants',cookies:committee.cookies,payload:{version:1,userIds:[excluded.user.id]}})).statusCode,400);
  assert.equal((await app.inject({url:'/api/submissions/history',cookies:member.cookies})).json()[0].text,'Own answer');
});

for (const kind of ['homework','affairs'] as const) test(`${kind} operations cannot borrow grants from the other module`,async t => {
  const {app,account,task} = await fixture(t);
  const otherKind = kind === 'homework' ? 'affairs' : 'homework';
  const unrelated = await account(PERMISSION_KEYS.filter(key=>key.startsWith(otherKind+'.')));
  const published = await task(kind), draft = await task(kind,'draft');
  assert.equal((await app.inject({url:draft.url,cookies:unrelated.cookies})).statusCode,404);
  for (const endpoint of ['/participants','/submissions','/submissions?history=1'])
    assert.equal((await app.inject({url:published.url+endpoint,cookies:unrelated.cookies})).statusCode,403);
  for (const payload of [{title:'Other module'}, {status:'draft'}, {status:'archived'}])
    assert.equal((await app.inject({method:'PUT',url:published.url,cookies:unrelated.cookies,payload:{version:1,...payload}})).statusCode,403);
  for (const endpoint of ['/export','/export-files'])
    assert.equal((await app.inject({method:'POST',url:published.url+endpoint,cookies:unrelated.cookies,payload:{}})).statusCode,403);
  assert.equal((await app.inject({url:published.url,cookies:unrelated.cookies})).json().version,1);
});

test('published edits require both grants and permission revocation takes effect on the existing session',async t=>{
  const {app,db,account,task} = await fixture(t);
  const editor = await account(['homework.drafts.read','homework.edit','homework.publish']);
  const published = await task();
  const first = await app.inject({method:'PUT',url:published.url,cookies:editor.cookies,payload:{version:1,title:'Allowed edit'}});
  assert.equal(first.statusCode,200,first.body);
  db.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(['homework.drafts.read','homework.edit']),editor.user.id);
  assert.equal((await app.inject({method:'PUT',url:published.url,cookies:editor.cookies,payload:{version:2,title:'Revoked edit'}})).statusCode,403);
  const unchanged = await app.inject({url:published.url,cookies:editor.cookies});
  assert.equal(unchanged.json().title,'Allowed edit');
  assert.equal(unchanged.json().version,2);
});

test('spreadsheet and attachment exports persist distinct permissions and revoke subsequent file access',async t=>{
  const {app,db,account,task} = await fixture(t,{
    configured:true,uploadUrl:async()=>({url:'https://storage.test/upload',headers:{}}),
    head:async()=>({size:4,mime:'text/plain'}),readHead:async()=>Buffer.from('text'),read:async()=>Buffer.from('text'),
    downloadUrl:async()=> 'https://storage.test/download',remove:async()=>{},put:async()=>{},
  });
  const student = await account([], 'student');
  const exporter = await account(['homework.export','homework.submissions.read','homework.participants.read']);
  const zipper = await account(['homework.exportFiles','homework.submissions.read']);
  const published = await task();
  const upload = await app.inject({method:'POST',url:'/api/files/upload',cookies:student.cookies,payload:{name:'answer.txt',size:4,mime:'text/plain',purpose:'submission',entityId:published.task.id}});
  assert.equal(upload.statusCode,200,upload.body);
  const attachment = upload.json().fileId;
  assert.equal((await app.inject({method:'POST',url:`/api/files/${attachment}/confirm`,cookies:student.cookies})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:published.url+'/submissions',cookies:student.cookies,payload:{attachments:[attachment]}})).statusCode,201);
  for(const [actor,endpoint,permission] of [[exporter,'export','homework.export'],[zipper,'export-files','homework.exportFiles']] as const){
    const response = await app.inject({method:'POST',url:published.url+'/'+endpoint,cookies:actor.cookies,payload:{}});
    assert.equal(response.statusCode,200,response.body);
    const fileId = response.json().fileId;
    assert.deepEqual(JSON.parse(db.get('SELECT scope FROM files WHERE id=?',fileId).scope),{kind:'task',id:published.task.id,permission});
    assert.equal((await app.inject({url:`/api/files/${fileId}`,cookies:actor.cookies})).statusCode,200);
    db.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(['homework.submissions.read','homework.participants.read']),actor.user.id);
    assert.equal((await app.inject({url:`/api/files/${fileId}`,cookies:actor.cookies})).statusCode,403);
  }
});
