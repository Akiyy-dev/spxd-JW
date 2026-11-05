import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

async function fixture(t: TestContext, storage?: import('../server/files.ts').StorageAdapter) {
  const { buildApp } = await import('../server/app.ts');
  const { createUser } = await import('../server/auth.ts');
  const { createStore } = await import('../server/db.ts');
  const db = createStore();
  const app = await buildApp({db,storage});
  t.after(async () => { await app.close(); db.close(); });
  const password = 'Initial-Pass2026!';
  async function account(username: string, role: 'admin'|'student'|'committee') {
    const user = createUser(db, {username,name:username,role,password,mustChangePassword:false});
    const response = await app.inject({method:'POST',url:'/api/auth/login',payload:{username,password}});
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies[0];
    return {user,cookies:{[cookie.name]:cookie.value}};
  }
  return {app,account};
}

test('publication snapshots the roster and withdrawal keeps the original submission history private', async t => {
  const {app, account} = await fixture(t);
  const admin = await account('admin','admin');
  const student = await account('student','student');
  const created = await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,
    payload:{title:'原作业',status:'published'}});
  assert.equal(created.statusCode, 201);
  const task = created.json();
  assert.equal(task.participantCount, 1);
  const newcomer = await account('newcomer','student');
  const url = `/api/homework/${task.id}`;
  const view = await app.inject({url,cookies:newcomer.cookies});
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().myParticipantStatus, null);
  assert.equal((await app.inject({method:'POST',url:`${url}/submissions`,cookies:newcomer.cookies,
    payload:{text:'尝试提交'}})).statusCode, 403);
  for (const text of ['第一次','第二次']) {
    assert.equal((await app.inject({method:'POST',url:`${url}/submissions`,cookies:student.cookies,
      payload:{text}})).statusCode, 201);
  }
  const latest = await app.inject({url:`${url}/submissions`,cookies:admin.cookies});
  assert.deepEqual(latest.json().map((submission:{text:string}) => submission.text), ['第二次']);
  const withdrawn = await app.inject({method:'PUT',url,cookies:admin.cookies,
    payload:{version:task.version,title:'私密草稿',status:'draft'}});
  assert.equal(withdrawn.statusCode, 200);
  assert.equal((await app.inject({url,cookies:student.cookies})).statusCode, 404);
  const history = await app.inject({url:'/api/submissions/history',cookies:student.cookies});
  assert.deepEqual(history.json().map((submission:{taskTitle:string,text:string}) => [submission.taskTitle,submission.text]),
    [['原作业','第二次'],['原作业','第一次']]);
  const republished = await app.inject({method:'PUT',url,cookies:admin.cookies,
    payload:{version:withdrawn.json().version,status:'published'}});
  assert.equal(republished.json().participantCount, 1);
});

test('affairs reject missing required answers and freeze fields after the first submission', async t => {
  const {app,account} = await fixture(t);
  const admin = await account('admin','admin');
  const committee = await account('committee','committee');
  const fields = [{id:'choice',label:'选择',type:'select',required:true,options:['甲','乙']}];
  const created = await app.inject({method:'POST',url:'/api/affairs',cookies:admin.cookies,
    payload:{title:'材料登记',fields,status:'published'}});
  assert.equal(created.statusCode, 201);
  const task = created.json();
  const url = `/api/affairs/${task.id}`;
  for (const answers of [{},{choice:'其他'}]) {
    assert.equal((await app.inject({method:'POST',url:`${url}/submissions`,cookies:committee.cookies,
      payload:{answers}})).statusCode, 400);
  }
  assert.equal((await app.inject({method:'POST',url:`${url}/submissions`,cookies:committee.cookies,
    payload:{answers:{choice:'甲'}}})).statusCode, 201);
  const changed = await app.inject({method:'PUT',url,cookies:admin.cookies,
    payload:{version:task.version,fields:[{...fields[0],label:'替换字段'}]}});
  assert.equal(changed.statusCode, 409);
  const append = await app.inject({method:'PUT',url,cookies:admin.cookies,
    payload:{version:task.version,fields:[...fields,{id:'note',label:'说明',type:'text',required:false}]}});
  assert.equal(append.statusCode, 200);
  const history = await app.inject({url:'/api/submissions/history',cookies:committee.cookies});
  assert.deepEqual(history.json()[0].fields, fields);
});

test('deactivation excuses incomplete tasks without removing completed work or restoring excused tasks on reactivation', async t => {
  const {app,account} = await fixture(t);
  const admin = await account('admin','admin');
  const student = await account('student','student');
  async function publish(title: string) {
    const response = await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,payload:{title,status:'published'}});
    assert.equal(response.statusCode, 201);
    return `/api/homework/${response.json().id}`;
  }
  const unfinished = await publish('未提交');
  const finished = await publish('已提交');
  assert.equal((await app.inject({method:'POST',url:`${finished}/submissions`,cookies:student.cookies,
    payload:{text:'已完成'}})).statusCode, 201);
  const accountUrl = `/api/users/${student.user.id}`;
  const changed = await app.inject({method:'PUT',url:accountUrl,cookies:admin.cookies,
    payload:{name:student.user.name,role:'student',active:false,financeManage:false,version:student.user.version}});
  assert.equal(changed.statusCode, 200);
  assert.deepEqual((await app.inject({url:'/api/auth/me',cookies:student.cookies})).json(), {user:null});
  assert.equal((await app.inject({url:unfinished,cookies:admin.cookies})).json().participantCount, 0);
  assert.equal((await app.inject({url:finished,cookies:admin.cookies})).json().submittedCount, 1);
  const restored = await app.inject({method:'PUT',url:accountUrl,cookies:admin.cookies,
    payload:{name:student.user.name,role:'student',active:true,financeManage:false,version:changed.json().version}});
  assert.equal(restored.statusCode, 200);
  assert.equal((await app.inject({url:`${unfinished}/participants`,cookies:admin.cookies})).json()[0].status, 'excused');
});

test('deadline edits preserve historical late status and archived tasks require a valid reopening deadline', async t => {
  const {app,account} = await fixture(t);
  const admin = await account('admin','admin');
  const student = await account('student','student');
  const created = await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,
    payload:{title:'补交作业',status:'published',deadline:'2020-09-01T00:00:00+08:00'}});
  assert.equal(created.statusCode, 201);
  const task = created.json();
  const url = `/api/homework/${task.id}`;
  const submit = () => app.inject({method:'POST',url:`${url}/submissions`,cookies:student.cookies,payload:{text:'答案'}});
  const edit = (version: number, changes: Record<string,unknown>) => app.inject({method:'PUT',url,cookies:admin.cookies,payload:{version,...changes}});
  assert.equal((await submit()).statusCode, 409);
  const opened = await edit(task.version, {allowLate:true});
  assert.equal(opened.statusCode, 200);
  const submitted = await submit();
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.json().late, true);
  const archived = await edit(opened.json().version, {status:'archived',allowLate:false});
  assert.equal(archived.statusCode, 200);
  assert.equal((await submit()).statusCode, 409);
  assert.equal((await edit(archived.json().version, {status:'draft'})).statusCode, 409);
  assert.equal((await edit(archived.json().version, {status:'published'})).statusCode, 409);
  assert.equal((await edit(archived.json().version, {status:'published',deadline:null})).statusCode, 200);
  const history = await app.inject({url:'/api/submissions/history',cookies:student.cookies});
  assert.equal(history.json()[0].late, true);
});

test('authorized task export stores a workbook with excused participants and the original form answers', async t => {
  const { default: ExcelJS } = await import('exceljs');
  let exported: Buffer | undefined;
  const unsupported = async () => { throw new Error('unexpected storage operation'); };
  const {app,account} = await fixture(t, {
    configured:true,
    uploadUrl:unsupported, head:unsupported, readHead:unsupported, downloadUrl:unsupported, remove:unsupported,
    put:async (_key, data) => { exported = data; },
  });
  const admin = await account('admin','admin');
  const student = await account('student','student');
  const created = await app.inject({method:'POST',url:'/api/affairs',cookies:admin.cookies,
    payload:{title:'登记',status:'published',fields:[{id:'note',label:'登记内容',type:'text',required:true}]}});
  assert.equal(created.statusCode, 201);
  const task = created.json();
  const url = `/api/affairs/${task.id}`;
  assert.equal((await app.inject({method:'POST',url:`${url}/submissions`,cookies:student.cookies,
    payload:{answers:{note:'已登记'}}})).statusCode, 201);
  const excused = await app.inject({method:'PUT',url:`${url}/participants`,cookies:admin.cookies,
    payload:{userIds:[],version:task.version}});
  assert.equal(excused.statusCode, 200);
  const endpoint = `${url}/export`;
  assert.equal((await app.inject({method:'POST',url:endpoint,cookies:student.cookies})).statusCode, 403);
  const result = await app.inject({method:'POST',url:endpoint,cookies:admin.cookies});
  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.json().fileId, 'string');
  assert.ok(exported);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported as unknown as ArrayBuffer);
  assert.equal(workbook.getWorksheet('参与情况')?.getCell('B2').value, '免交');
  assert.equal(workbook.getWorksheet('提交历史')?.getCell('G2').value, '登记内容：已登记');
});

test('new tasks bind confirmed staged attachments and withdrawal hides them from students', async t => {
  const {app,account} = await fixture(t, {
    configured:true,
    uploadUrl:async () => ({url:'https://storage.test/upload',headers:{}}),
    head:async () => ({size:4,mime:'text/plain'}),
    readHead:async () => Buffer.from('text'),
    downloadUrl:async () => 'https://storage.test/download',
    remove:async () => {},
    put:async () => {},
  });
  const admin = await account('admin','admin');
  const student = await account('student','student');
  const pending = await app.inject({method:'POST',url:'/api/files/upload',cookies:admin.cookies,
    payload:{name:'notes.txt',size:4,mime:'text/plain',purpose:'task-attachment'}});
  assert.equal(pending.statusCode, 200);
  const {fileId} = pending.json();
  const confirm = await app.inject({method:'POST',url:`/api/files/${fileId}/confirm`,cookies:admin.cookies});
  assert.equal(confirm.statusCode, 200);
  const published = await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,
    payload:{title:'附件作业',status:'published',attachments:[fileId]}});
  assert.equal(published.statusCode, 201);
  const task = published.json();
  const file = () => app.inject({url:`/api/files/${fileId}`,cookies:student.cookies});
  const visible = await file();
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.json().entityId, task.id);
  const withdrawn = await app.inject({method:'PUT',url:`/api/homework/${task.id}`,cookies:admin.cookies,
    payload:{status:'draft',version:task.version}});
  assert.equal(withdrawn.statusCode, 200);
  assert.equal((await file()).statusCode, 403);
});

test('missing COS is reported as a service-unavailable error on export', async t => {
  const unexpectedStorage = async () => { throw new Error('unexpected storage operation'); };
  const {app,account} = await fixture(t, {
    configured:false, uploadUrl:unexpectedStorage, head:unexpectedStorage, readHead:unexpectedStorage,
    downloadUrl:unexpectedStorage, put:unexpectedStorage, remove:unexpectedStorage,
  });
  const admin = await account('admin','admin');
  const task = (await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,payload:{title:'附件作业'}})).json();
  const result = await app.inject({method:'POST',url:`/api/homework/${task.id}/export`,cookies:admin.cookies});
  assert.equal(result.statusCode, 503);
  assert.match(result.json().message, /COS/);
});

test('task ZIP contains the latest submitted attachments only and supports selecting students', async t => {
  const {default: JSZip} = await import('jszip');
  const contents = new Map<string, Buffer>();
  let exported: Buffer | undefined;
  const {app,account} = await fixture(t, {
    configured:true,
    uploadUrl:async key => ({url:key,headers:{}}),
    head:async key => ({size:contents.get(key)!.length,mime:'text/plain'}),
    readHead:async key => contents.get(key)!,
    read:async key => contents.get(key)!,
    downloadUrl:async () => 'https://storage.test/download',
    remove:async () => {},
    put:async (_key, data) => { exported = data; },
  });
  const admin = await account('admin','admin');
  const first = await account('first','student');
  const second = await account('second','student');
  const created = await app.inject({method:'POST',url:'/api/homework',cookies:admin.cookies,
    payload:{title:'文件收集',status:'published'}});
  assert.equal(created.statusCode, 201);
  const {id} = created.json();
  const url = `/api/homework/${id}`;

  async function submit(accountData: typeof first, content: string) {
    const {cookies} = accountData;
    const upload = await app.inject({method:'POST',url:'/api/files/upload',cookies,
      payload:{name:'work.txt',size:Buffer.byteLength(content),mime:'text/plain',purpose:'submission',entityId:id}});
    assert.equal(upload.statusCode, 200);
    const {fileId,url:key} = upload.json();
    contents.set(key, Buffer.from(content));
    assert.equal((await app.inject({method:'POST',url:`/api/files/${fileId}/confirm`,cookies})).statusCode, 200);
    const result = await app.inject({method:'POST',url:`${url}/submissions`,cookies,payload:{attachments:[fileId]}});
    assert.equal(result.statusCode, 201);
  }
  await submit(first, 'first old');
  await submit(first, 'first latest');
  await submit(second, 'second latest');

  const endpoint = `${url}/export-files`;
  assert.equal((await app.inject({method:'POST',url:endpoint,cookies:first.cookies})).statusCode, 403);
  async function zipContents(userIds?: string[]) {
    const result = await app.inject({method:'POST',url:endpoint,cookies:admin.cookies,
      ...(userIds ? {payload:{userIds}} : {})});
    assert.equal(result.statusCode, 200);
    assert.equal(typeof result.json().fileId, 'string');
    assert.ok(exported);
    const zip = await JSZip.loadAsync(exported);
    return (await Promise.all(Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.async('string')))).sort();
  }
  assert.deepEqual(await zipContents([first.user.id]), ['first latest']);
  assert.deepEqual(await zipContents(), ['first latest', 'second latest']);
});
