import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../server/app.ts';
import { createUser } from '../server/auth.ts';
import { createStore } from '../server/db.ts';
import type { StorageAdapter } from '../server/files.ts';
import type { Permission, Role } from '../shared/permissions.ts';

const bytes = Buffer.from('%PDF-1.7');
async function fixture(t: TestContext) {
  const db = createStore();
  const storage: StorageAdapter = { configured: true,
    uploadUrl: async () => ({ url: 'https://storage.test/upload', headers: {} }),
    head: async () => ({ size: bytes.length, mime: 'application/pdf' }), readHead: async () => bytes,
    read: async () => bytes, downloadUrl: async () => 'https://storage.test/download', put: async () => {}, remove: async () => {},
  };
  const app = await buildApp({ db, storage });
  t.after(async () => { await app.close(); db.close(); });
  async function account(permissions: Permission[] = [], role: Role = 'admin', inClass = false) {
    const user = createUser(db, { username: randomUUID(), name: '测试成员', password: 'Files-Tests2026!', role, permissions, inClass, mustChangePassword: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: 'Files-Tests2026!' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = { [login.cookies[0].name]: login.cookies[0].value };
    return { user, cookies };
  }
  type Account = Awaited<ReturnType<typeof account>>;
  const grants = (actor: Account, permissions: Permission[]) => db.run('UPDATE users SET permissions=? WHERE id=?', JSON.stringify(permissions), actor.user.id);
  const upload = (actor: Account, purpose: string, extra: object = {}) => app.inject({ method: 'POST', url: '/api/files/upload', cookies: actor.cookies, payload: { purpose, name: 'test.pdf', size: bytes.length, ...extra } });
  const confirm = (actor: Account, id: string) => app.inject({ method: 'POST', url: `/api/files/${id}/confirm`, cookies: actor.cookies });
  async function reads(actor: Account, id: string, status: number) {
    for (const [method, suffix] of [['GET', ''], ['POST', '/download'], ['GET', '/preview']] as const) {
      const result = await app.inject({ method, url: `/api/files/${id}${suffix}`, cookies: actor.cookies });
      assert.equal(result.statusCode, status, `${method} ${suffix}: ${result.body}`);
    }
  }
  function file(actor: Account, purpose: string, entityId: string | null, scope?: object) {
    const id = randomUUID();
    db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,scope,created_at) VALUES(?,'test.pdf',?,'application/pdf',?,?,?,?, 'ready',?,?)",
      id, bytes.length, id, purpose, entityId, actor.user.id, scope ? JSON.stringify(scope) : null, new Date().toISOString());
    return id;
  }
  function task(actor: Account, kind = 'homework', status = 'draft') {
    const id = randomUUID();
    db.run('INSERT INTO tasks(id,kind,title,status,author_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, kind, '测试任务', status, actor.user.id, new Date().toISOString(), new Date().toISOString());
    return id;
  }
  function entry(actor: Account, receiptIds: string[] = []) {
    const id = randomUUID();
    db.run("INSERT INTO finance_entries(id,type,amount,date,receipt_ids,author_id,created_at) VALUES(?,'expense',100,'2026-11-09',?,?,?)", id, JSON.stringify(receiptIds), actor.user.id, new Date().toISOString());
    return id;
  }
  return { db, app, storage, account, grants, upload, confirm, reads, file, task, entry };
}

test('task staging requires its own module context and rechecks grants on confirm, reads and binding', async t => {
  const f = await fixture(t), actor = await f.account(['homework.create', 'affairs.create']);
  assert.equal((await f.upload(actor, 'task-attachment')).statusCode, 403);
  const staged = await f.upload(actor, 'task-attachment', { context: 'homework' });
  assert.equal(staged.statusCode, 200, staged.body);
  const id = staged.json().fileId;
  assert.deepEqual(JSON.parse(f.db.get('SELECT scope FROM files WHERE id=?', id).scope), { context: 'homework' });
  f.grants(actor, ['affairs.create']);
  assert.equal((await f.confirm(actor, id)).statusCode, 403);
  f.grants(actor, ['homework.create', 'affairs.create']);
  assert.equal((await f.confirm(actor, id)).statusCode, 200);
  await f.reads(actor, id, 200);
  const transplant = await f.app.inject({ method: 'POST', url: '/api/affairs', cookies: actor.cookies, payload: { title: 'Cross-kind', attachments: [id] } });
  assert.equal(transplant.statusCode, 403, transplant.body);
  f.grants(actor, ['affairs.create']);
  await f.reads(actor, id, 403);
  assert.equal(f.db.get('SELECT entity_id FROM files WHERE id=?', id).entity_id, null);
});

test('existing tasks derive kind and publication requirements from the database', async t => {
  const f = await fixture(t), owner = await f.account([], 'committee');
  const editor = await f.account(['homework.drafts.read', 'homework.edit', 'affairs.drafts.read', 'affairs.edit']);
  const draft = f.task(owner), published = f.task(owner, 'homework', 'published');
  assert.equal((await f.upload(editor, 'task-attachment', { entityId: draft, context: 'affairs' })).statusCode, 403);
  assert.equal((await f.upload(editor, 'task-attachment', { entityId: published, context: 'homework' })).statusCode, 403);
  assert.equal((await f.upload(editor, 'task-attachment', { entityId: draft, context: 'homework' })).statusCode, 200);
  const fileId = f.file(owner, 'task-attachment', draft, { context: 'homework' });
  f.db.run('UPDATE tasks SET attachments=? WHERE id=?', JSON.stringify([fileId]), draft);
  f.grants(editor, ['homework.drafts.read']);
  await f.reads(editor, fileId, 200);
  f.grants(editor, ['affairs.drafts.read']);
  await f.reads(editor, fileId, 403);
});

test('receipt staging checks the exact operation and revocation instead of full-read access', async t => {
  const f = await fixture(t), actor = await f.account(['finance.read', 'finance.entries.create']);
  assert.equal((await f.upload(actor, 'receipt')).statusCode, 403);
  assert.equal((await f.upload(actor, 'receipt', { context: 'finance.payments.create' })).statusCode, 403);
  const staged = await f.upload(actor, 'receipt', { context: 'finance.entries.create' });
  assert.equal(staged.statusCode, 200, staged.body);
  const id = staged.json().fileId;
  f.grants(actor, ['finance.read']);
  assert.equal((await f.confirm(actor, id)).statusCode, 403);
  f.grants(actor, ['finance.read', 'finance.entries.create']);
  assert.equal((await f.confirm(actor, id)).statusCode, 200);
  f.grants(actor, ['finance.read', 'finance.payments.create']);
  await f.reads(actor, id, 403);
  const feeId = randomUUID();
  f.db.run('INSERT INTO fees(id,title,amount,user_ids,created_at) VALUES(?,?,?,?,?)', feeId, '费用', 100, JSON.stringify([actor.user.id]), new Date().toISOString());
  f.db.run('UPDATE users SET in_class=1 WHERE id=?', actor.user.id);
  const result = await f.app.inject({ method: 'POST', url: '/api/finance/payments', cookies: actor.cookies, payload: { feeId, userId: actor.user.id, amount: 100, date: '2026-11-09', description: '', receiptIds: [id], publicReceipt: false, idempotencyKey: randomUUID() } });
  assert.equal(result.statusCode, 403, result.body);
});

test('receipt edits retain bound creation-context files but reject staged creation-context files', async t => {
  const f = await fixture(t), actor = await f.account(['finance.read', 'finance.entries.create', 'finance.entries.edit']);
  const id = f.entry(actor), current = f.file(actor, 'receipt', id, { context: 'finance.entries.create' });
  f.db.run('UPDATE finance_entries SET receipt_ids=? WHERE id=?', JSON.stringify([current]), id);
  f.grants(actor, ['finance.read', 'finance.entries.edit']);
  const uploaded = await f.upload(actor, 'receipt', { entityId: id, context: 'finance.entries.edit' });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal((await f.confirm(actor, uploaded.json().fileId)).statusCode, 200);
  const update = await f.app.inject({ method: 'PUT', url: `/api/finance/entries/${id}`, cookies: actor.cookies, payload: { version: 1, reason: '追加凭证', receiptIds: [current, uploaded.json().fileId] } });
  assert.equal(update.statusCode, 200, update.body);
  const staged = f.file(actor, 'receipt', null, { context: 'finance.entries.create' });
  const denied = await f.app.inject({ method: 'PUT', url: `/api/finance/entries/${id}`, cookies: actor.cookies, payload: { version: 2, reason: '跨操作', receiptIds: [staged] } });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('private current receipts require full read and removed receipts additionally require history', async t => {
  const f = await fixture(t), actor = await f.account(['finance.read']);
  const id = f.entry(actor), current = f.file(actor, 'receipt', id), historical = f.file(actor, 'receipt', id);
  f.db.run('UPDATE finance_entries SET receipt_ids=? WHERE id=?', JSON.stringify([current]), id);
  f.db.run('INSERT INTO finance_versions(id,entity_type,entity_id,data,version,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), 'entry', id, JSON.stringify({ before: { receiptIds: [historical] } }), 1, '更换', actor.user.id, new Date().toISOString());
  await f.reads(actor, current, 200);
  await f.reads(actor, historical, 403);
  f.grants(actor, ['finance.read', 'finance.history']);
  await f.reads(actor, historical, 200);
  f.grants(actor, []);
  await f.reads(actor, current, 403);
});

test('resource file reads separate current drafts, archived records and historical attachments', async t => {
  const f = await fixture(t), actor = await f.account(['resources.create']);
  const resourceId = randomUUID(), current = f.file(actor, 'resource', resourceId), historical = f.file(actor, 'resource', resourceId);
  f.db.run('INSERT INTO resources(id,title,attachments,status,author_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', resourceId, '私有资料', JSON.stringify([current]), 'draft', actor.user.id, new Date().toISOString(), new Date().toISOString());
  f.db.run('INSERT INTO resource_versions(id,resource_id,data,version,created_at) VALUES(?,?,?,?,?)', randomUUID(), resourceId, JSON.stringify({ status: 'draft', attachments: [historical] }), 1, new Date().toISOString());
  await f.reads(actor, current, 403);
  f.grants(actor, ['resources.drafts.read']);
  await f.reads(actor, current, 200);
  await f.reads(actor, historical, 403);
  f.db.run("UPDATE resources SET status='archived' WHERE id=?", resourceId);
  await f.reads(actor, current, 403);
  f.grants(actor, ['resources.archived.read']);
  await f.reads(actor, current, 200);
  f.grants(actor, ['resources.history.read']);
  await f.reads(actor, historical, 403);
  f.grants(actor, ['resources.archived.read', 'resources.history.read']);
  await f.reads(actor, historical, 403);
  f.grants(actor, ['resources.archived.read', 'resources.drafts.read', 'resources.history.read']);
  await f.reads(actor, historical, 200);
  f.db.run("UPDATE resources SET status='published' WHERE id=?", resourceId);
  f.grants(actor, ['resources.history.read']);
  await f.reads(actor, historical, 403);
  f.grants(actor, []);
  await f.reads(actor, current, 200);
});

test('submission files require answer-read permission, while submitters retain their own saved attachments', async t => {
  const f = await fixture(t), actor = await f.account(['homework.drafts.read', 'homework.edit']);
  const student = await f.account([], 'student'), taskId = f.task(actor, 'homework', 'published');
  const id = f.file(student, 'submission', taskId);
  f.db.run('INSERT INTO submissions(id,task_id,user_id,attachments,task_title,version,created_at) VALUES(?,?,?,?,?,1,?)', randomUUID(), taskId, student.user.id, JSON.stringify([id]), '提交', new Date().toISOString());
  await f.reads(actor, id, 403);
  f.grants(actor, ['homework.submissions.read']);
  await f.reads(actor, id, 200);
  f.grants(actor, ['affairs.submissions.read']);
  await f.reads(actor, id, 403);
  await f.reads(student, id, 200);
});

test('member-avatar grants exclude protected administrator targets while own avatars stay available', async t => {
  const f = await fixture(t), actor = await f.account(['class.members.edit']), other = await f.account(), root = await f.account([], 'super_admin');
  const student = await f.account([], 'student');
  const request = { name: 'avatar.png', mime: 'image/png' };
  for (const target of [other, root]) assert.equal((await f.upload(actor, 'avatar', { ...request, entityId: target.user.id })).statusCode, 403);
  assert.equal((await f.upload(actor, 'avatar', { ...request, entityId: student.user.id })).statusCode, 200);
  f.grants(actor, []);
  assert.equal((await f.upload(actor, 'avatar', { ...request, entityId: actor.user.id })).statusCode, 200);
  assert.equal((await f.upload(actor, 'class-photo', request)).statusCode, 403);
});

test('export files enforce exact saved permission and conservatively authorize legacy task scopes', async t => {
  const f = await fixture(t), actor = await f.account(['homework.submissions.read', 'homework.exportFiles']);
  const taskId = f.task(actor, 'homework', 'published');
  const modern = f.file(actor, 'export', taskId, { kind: 'task', id: taskId, permission: 'homework.exportFiles' });
  const legacy = f.file(actor, 'export', taskId, { kind: 'task', id: taskId });
  await f.reads(actor, modern, 200);
  await f.reads(actor, legacy, 403);
  f.grants(actor, ['homework.submissions.read', 'homework.participants.read', 'homework.exportFiles', 'homework.export']);
  await f.reads(actor, legacy, 200);
  f.grants(actor, ['homework.submissions.read', 'homework.participants.read', 'homework.export']);
  await f.reads(actor, modern, 403);
  const forged = f.file(actor, 'export', taskId, { kind: 'task', id: taskId, permission: 'homework.submissions.read' });
  await f.reads(actor, forged, 403);
});

test('upload signing rechecks revoked grants before returning a URL or persisting a pending file', async t => {
  const f=await fixture(t),actor=await f.account(['homework.create']);
  f.storage.uploadUrl=async()=>{f.grants(actor,[]);return{url:'https://storage.test/revoked-upload',headers:{}};};
  const response=await f.upload(actor,'task-attachment',{context:'homework'});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(f.db.all('SELECT id FROM files').length,0);
});

for(const reason of ['grant','role','disabled','password','session'] as const)test(`confirmation rejects ${reason} changes during storage verification`,async t=>{
  const f=await fixture(t),actor=await f.account(['homework.create']);
  const uploaded=await f.upload(actor,'task-attachment',{context:'homework'}),id=uploaded.json().fileId;
  f.storage.readHead=async()=>{
    if(reason==='grant')f.grants(actor,[]);
    if(reason==='role')f.db.run("UPDATE users SET role='student' WHERE id=?",actor.user.id);
    if(reason==='disabled')f.db.run('UPDATE users SET active=0 WHERE id=?',actor.user.id);
    if(reason==='password')f.db.run('UPDATE users SET must_change_password=1 WHERE id=?',actor.user.id);
    if(reason==='session')f.db.run('DELETE FROM sessions WHERE user_id=?',actor.user.id);
    return bytes;
  };
  const response=await f.confirm(actor,id);
  assert.equal(response.statusCode,reason==='disabled'||reason==='session'?401:403,response.body);
  assert.equal(f.db.get('SELECT status FROM files WHERE id=?',id).status,'pending');
});

for(const operation of ['download','preview'] as const)for(const reason of ['grant','unlinked','file-status'] as const)test(`${operation} rechecks ${reason} after asynchronous storage access`,async t=>{
  const f=await fixture(t),actor=await f.account(['finance.read']);
  const entry=f.entry(actor),id=f.file(actor,'receipt',entry);
  f.db.run('UPDATE finance_entries SET receipt_ids=? WHERE id=?',JSON.stringify([id]),entry);
  const change=()=>{
    if(reason==='grant')f.grants(actor,[]);
    if(reason==='unlinked')f.db.run("UPDATE finance_entries SET receipt_ids='[]' WHERE id=?",entry);
    if(reason==='file-status')f.db.run("UPDATE files SET status='cleaning' WHERE id=?",id);
  };
  if(operation==='download')f.storage.downloadUrl=async()=>{change();return'https://storage.test/revoked-download';};
  else f.storage.read=async()=>{change();return bytes;};
  const response=await f.app.inject({method:operation==='download'?'POST':'GET',url:`/api/files/${id}/${operation}`,cookies:actor.cookies});
  assert.equal(response.statusCode,403,response.body);
});

test('public photo preview rechecks whether the image is still current after reading storage',async t=>{
  const f=await fixture(t),actor=await f.account([], 'super_admin'),id=f.file(actor,'class-photo','class');
  f.db.setSetting('class',{photoFileId:id});
  f.db.run("UPDATE files SET mime='image/png',name='photo.png',size=8 WHERE id=?",id);
  f.storage.read=async()=>{f.db.setSetting('class',{photoFileId:'replacement'});return Buffer.from([137,80,78,71,13,10,26,10]);};
  assert.equal((await f.app.inject(`/api/public/photo/${id}`)).statusCode,404);
});

test('exports recheck grants after upload and do not persist inaccessible output',async t=>{
  const f=await fixture(t),actor=await f.account(['finance.read','finance.export']);
  const removed:string[]=[];
  f.storage.put=async()=>{f.grants(actor,['finance.read']);};
  f.storage.remove=async key=>{removed.push(key);};
  const response=await f.app.inject({method:'POST',url:'/api/finance/export',cookies:actor.cookies});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(f.db.all("SELECT id FROM files WHERE purpose='export'").length,0);
  assert.equal(removed.length,1);
});

for(const format of ['finance','task spreadsheet','task ZIP'] as const)for(const reason of ['logout','username'] as const)test(`${format} export rejects ${reason} session invalidation during storage upload`,async t=>{
  const f=await fixture(t),actor=await f.account(['finance.read','finance.export','homework.participants.read','homework.submissions.read','homework.export','homework.exportFiles']);
  let url='/api/finance/export';
  if(format!=='finance'){
    const task=f.task(actor,'homework','published'),id=f.file(actor,'submission',task);
    f.db.run('INSERT INTO submissions(id,task_id,user_id,attachments,task_title,version,created_at) VALUES(?,?,?,?,?,1,?)',randomUUID(),task,actor.user.id,JSON.stringify([id]),'提交',new Date().toISOString());
    url=`/api/homework/${task}/${format==='task ZIP'?'export-files':'export'}`;
  }
  const uploaded:string[]=[],removed:string[]=[];
  f.storage.put=async key=>{
    uploaded.push(key);
    if(reason==='username')f.db.run('UPDATE users SET username=?,version=version+1 WHERE id=?','renamed-review',actor.user.id);
    f.db.run('DELETE FROM sessions WHERE user_id=?',actor.user.id);
  };
  f.storage.remove=async key=>{removed.push(key);};
  const response=await f.app.inject({method:'POST',url,cookies:actor.cookies,payload:{}});
  assert.equal(response.statusCode,401,response.body);
  assert.equal(f.db.all("SELECT id FROM files WHERE purpose='export'").length,0);
  assert.equal(uploaded.length,1);
  assert.deepEqual(removed,uploaded);
});

for(const reason of ['logout','username'] as const)test(`ZIP export rejects ${reason} session invalidation while reading source files`,async t=>{
  const f=await fixture(t),actor=await f.account(['homework.submissions.read','homework.exportFiles']);
  const task=f.task(actor,'homework','published'),id=f.file(actor,'submission',task);
  f.db.run('INSERT INTO submissions(id,task_id,user_id,attachments,task_title,version,created_at) VALUES(?,?,?,?,?,1,?)',randomUUID(),task,actor.user.id,JSON.stringify([id]),'提交',new Date().toISOString());
  let uploads=0;
  f.storage.read=async()=>{
    if(reason==='username')f.db.run('UPDATE users SET username=?,version=version+1 WHERE id=?','renamed-review',actor.user.id);
    f.db.run('DELETE FROM sessions WHERE user_id=?',actor.user.id);
    return bytes;
  };
  f.storage.put=async()=>{uploads++;};
  const response=await f.app.inject({method:'POST',url:`/api/homework/${task}/export-files`,cookies:actor.cookies,payload:{}});
  assert.equal(response.statusCode,401,response.body);
  assert.equal(f.db.all("SELECT id FROM files WHERE purpose='export'").length,0);
  assert.equal(uploads,0);
});

test('ZIP export rechecks grants after fetching submission files',async t=>{
  const f=await fixture(t),actor=await f.account(['homework.submissions.read','homework.exportFiles']);
  const submitter=await f.account([], 'student'),task=f.task(actor,'homework','published'),id=f.file(submitter,'submission',task);
  f.db.run('INSERT INTO submissions(id,task_id,user_id,attachments,task_title,version,created_at) VALUES(?,?,?,?,?,1,?)',randomUUID(),task,submitter.user.id,JSON.stringify([id]),'提交',new Date().toISOString());
  f.storage.read=async()=>{f.grants(actor,['homework.submissions.read']);return bytes;};
  const response=await f.app.inject({method:'POST',url:`/api/homework/${task}/export-files`,cookies:actor.cookies,payload:{}});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(f.db.all("SELECT id FROM files WHERE purpose='export'").length,0);
});
