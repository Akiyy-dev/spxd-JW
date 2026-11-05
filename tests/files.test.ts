import {test} from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { createStore } from '../server/db.ts';
import { bindAttachments, cleanupFiles, createBundle, registerFiles, validateAttachments, type StorageAdapter } from '../server/files.ts';
import { registerFinance } from '../server/finance.ts';
import type { User } from '../server/common.ts';
const student:User={id:'s',name:'同学',username:'s',role:'student',active:true,financeManage:false,mustChangePassword:false,version:1};
const manager:User={...student,id:'m',username:'m',role:'committee'};
const date = '2026-01-01';
async function setup(user: User | null, configured = false, overrides: Partial<StorageAdapter> = {}) {
  const db = createStore();
  for (const u of [student, manager, administrator]) {
    db.run('INSERT INTO users(id,username,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)',
      u.id, u.username, u.name, 'x', u.role, date);
  }
  const storage: StorageAdapter = {
    configured,
    uploadUrl: async () => ({ url: 'https://upload.example', headers: {} }),
    head: async () => ({ size: 20, mime: 'application/pdf' }),
    readHead: async () => Buffer.from('%PDF-1.7'),
    downloadUrl: async () => 'https://download.example',
    put: async () => {},
    remove: async () => {},
    ...overrides,
  };
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async req => { req.user = user; });
  app.setErrorHandler((error: any, _req, reply) => reply.code(error.statusCode ?? 500).send({ message: error.message }));
  registerFiles(app, db, storage);
  registerFinance(app, db);
  await app.ready();
  return { app, db, storage, setUser: (next: User) => { user = next; } };
}
test('guest cannot request upload and configured status hides secrets',async()=>{const{app,db}=await setup(null);assert.equal((await app.inject({method:'POST',url:'/api/files/upload',payload:{}})).statusCode,401);await app.close();db.close()});
test('missing COS rejects actual uploads and students cannot upload resources',async()=>{let s=await setup(manager);assert.equal((await s.app.inject({method:'POST',url:'/api/files/upload',payload:{name:'note.pdf',size:20,mime:'application/pdf',purpose:'resource'}})).statusCode,503);await s.app.close();s.db.close();s=await setup(student,true);assert.equal((await s.app.inject({method:'POST',url:'/api/files/upload',payload:{name:'note.pdf',size:20,mime:'application/pdf',purpose:'resource'}})).statusCode,403);await s.app.close();s.db.close()});
test('actual size is verified and foreign file cannot be attached',async()=>{const{app,db}=await setup(manager,true);const created=await app.inject({method:'POST',url:'/api/files/upload',payload:{name:'note.pdf',size:12,mime:'application/pdf',purpose:'resource'}});assert.equal(created.statusCode,200,created.body);const id=created.json().fileId;assert.equal((await app.inject({method:'POST',url:`/api/files/${id}/confirm`})).statusCode,400);assert.throws(()=>validateAttachments(db,student,[id],'submission','task'));await app.close();db.close()});
test('ready private receipt cannot be signed by a student',async()=>{const{app,db}=await setup(student,true);db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','receipt','r.pdf',20,'application/pdf','private/r','receipt','entry','m','ready','2026-01-01');assert.equal((await app.inject({method:'POST',url:'/api/files/receipt/download',payload:{}})).statusCode,403);await app.close();db.close()});

const financeManager: User = { ...manager, financeManage: true };
const administrator: User = { ...manager, id: 'a', username: 'a', name: '管理员', role: 'admin' };

for (const entity of ['entry', 'payment'] as const) {
  test(`administrators without a finance flag upload, confirm and bind private receipts to a ${entity}`, async t => {
    const { app, db, setUser } = await setup(administrator, true);
    t.after(async () => { await app.close(); db.close(); });
    const upload = await app.inject({ method: 'POST', url: '/api/files/upload',
      payload: { name: 'receipt.pdf', size: 20, mime: 'application/pdf', purpose: 'receipt' } });
    assert.equal(upload.statusCode, 200, upload.body);
    const fileId = upload.json().fileId;
    const fileUrl = '/api/files/' + fileId;
    setUser(financeManager);
    assert.equal((await app.inject({ method: 'POST', url: fileUrl + '/confirm' })).statusCode, 404);
    setUser(administrator);
    const confirmed = await app.inject({ method: 'POST', url: fileUrl + '/confirm' });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().status, 'ready');
    assert.equal(confirmed.json().ownerId, administrator.id);
    setUser(financeManager);
    assert.equal((await app.inject({ method: 'POST', url: fileUrl + '/download' })).statusCode, 403);
    const entryInput = { type: 'expense', amount: 100, category: '其他', description: '', date,
      receiptIds: [fileId], publicReceipt: false, idempotencyKey: randomUUID() };
    assert.equal((await app.inject({ method: 'POST', url: '/api/finance/entries', payload: entryInput })).statusCode, 403);
    setUser(administrator);
    let entityId: string;
    if (entity === 'entry') {
      const created = await app.inject({ method: 'POST', url: '/api/finance/entries', payload: entryInput });
      assert.equal(created.statusCode, 200, created.body);
      entityId = created.json().id;
    } else {
      const seeded = seedPaymentReceipt(db);
      entityId = seeded.paymentId;
      const updated = await app.inject({ method: 'PUT', url: '/api/finance/payments/' + entityId,
        payload: { receiptIds: [seeded.fileId, fileId], publicReceipt: false, version: 1, reason: '补充凭证' } });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.deepEqual(updated.json().receiptIds, [seeded.fileId, fileId]);
    }
    const stored = db.get('SELECT entity_id,expires_at FROM files WHERE id=?', fileId);
    assert.equal(stored?.entity_id, entityId);
    assert.equal(stored?.expires_at, null);
    assert.equal((await app.inject({ method: 'POST', url: fileUrl + '/download' })).statusCode, 200);
    // Administrator access does not let a receipt be rebound to another record.
    assert.equal((await app.inject({ method: 'POST', url: '/api/finance/entries',
      payload: { ...entryInput, idempotencyKey: randomUUID() } })).statusCode, 403);
    for (const member of [manager, student, { ...student, financeManage: true }]) {
      setUser(member);
      assert.equal((await app.inject({ method: 'POST', url: fileUrl + '/download' })).statusCode, 403);
      assert.equal((await app.inject({ method: 'GET', url: fileUrl })).statusCode, 403);
    }
  });
}

test('unauthorized committee members and students cannot upload or confirm finance receipts', async t => {
  const { app, db, setUser } = await setup(manager, true);
  t.after(async () => { await app.close(); db.close(); });
  for (const member of [manager, student, { ...student, financeManage: true }]) {
    setUser(member);
    const payload = { name: 'receipt.pdf', size: 20, mime: 'application/pdf', purpose: 'receipt' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/files/upload', payload })).statusCode, 403);
    const id = randomUUID();
    db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,owner_id,status,created_at,expires_at) VALUES(?,'receipt.pdf',20,'application/pdf',?,'receipt',?,'pending',?,?)",
      id, id, member.id, date, new Date(Date.now() + 60000).toISOString());
    assert.equal((await app.inject({ method: 'POST', url: '/api/files/' + id + '/confirm' })).statusCode, 403);
  }
});

function seedPaymentReceipt(db: ReturnType<typeof createStore>) {
  const paymentId = randomUUID();
  const feeId = randomUUID();
  const fileId = randomUUID();
  db.run('INSERT INTO fees(id,title,amount,user_ids,created_at) VALUES(?,?,?,?,?)', feeId, '班费', 100, '["s"]', date);
  db.run('INSERT INTO payments(id,fee_id,user_id,amount,date,receipt_ids,idempotency_key,author_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    paymentId, feeId, student.id, 100, date, JSON.stringify([fileId]), paymentId, manager.id, date);
  db.run("INSERT INTO finance_entries(id,type,amount,date,receipt_ids,public_receipt,payment_id,author_id,created_at) VALUES(?,'income',100,?,?,1,?,?,?)",
    randomUUID(), date, JSON.stringify([fileId]), paymentId, manager.id, date);
  db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,created_at) VALUES(?,'r.pdf',20,'application/pdf',?,'receipt',?,?,'ready',?)",
    fileId, fileId, paymentId, manager.id, date);
  return { paymentId, fileId };
}

test('authorized finance readers can sign a replaced receipt after the payment is voided', async t => {
  const { app, db, setUser } = await setup(financeManager, true);
  t.after(async () => { await app.close(); db.close(); });
  const { paymentId, fileId } = seedPaymentReceipt(db);
  const paymentUrl = '/api/finance/payments/' + paymentId;
  const download = '/api/files/' + fileId + '/download';
  assert.equal((await app.inject({
    method: 'PUT', url: paymentUrl, payload: { receiptIds: [], version: 1, reason: '移除旧凭证' },
  })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: download })).statusCode, 200);
  setUser(student);
  assert.equal((await app.inject({ method: 'POST', url: download })).statusCode, 403);
  setUser(financeManager);
  assert.equal((await app.inject({
    method: 'POST', url: paymentUrl + '/void', payload: { version: 2, reason: '退回缴费' },
  })).statusCode, 200);
  setUser(administrator);
  assert.equal((await app.inject({ method: 'POST', url: download })).statusCode, 200);
  setUser(student);
  assert.equal((await app.inject({ method: 'POST', url: download })).statusCode, 403);
});

test('public receipt metadata omits payment and owner IDs for ordinary members', async t => {
  const { app, db, setUser } = await setup(student, true);
  t.after(async () => { await app.close(); db.close(); });
  const { paymentId, fileId } = seedPaymentReceipt(db);
  const url = '/api/files/' + fileId;
  for (const member of [student, manager]) {
    setUser(member);
    const publicFile = await app.inject({ method: 'GET', url });
    assert.equal(publicFile.statusCode, 200);
    assert.equal(publicFile.json().name, 'r.pdf');
    assert.equal('entityId' in publicFile.json(), false);
    assert.equal('ownerId' in publicFile.json(), false);
  }
  for (const auditor of [administrator, financeManager]) {
    setUser(auditor);
    const fullFile = await app.inject({ method: 'GET', url });
    assert.equal(fullFile.json().entityId, paymentId);
    assert.equal(fullFile.json().ownerId, manager.id);
  }
});

test('cleanup removes confirmed unbound staging files with entity IDs and keeps bound files', async t => {
  const removed: string[] = [];
  const { app, db, storage } = await setup(manager, true, { remove: async key => { removed.push(key); } });
  t.after(async () => { await app.close(); db.close(); });
  db.run("INSERT INTO tasks(id,kind,title,author_id,created_at,updated_at) VALUES('task','homework','作业','m',?,?)", date, date);
  async function stage() {
    const upload = await app.inject({
      method: 'POST', url: '/api/files/upload', payload: { name: 'r.pdf', size: 20, purpose: 'task-attachment', entityId: 'task' },
    });
    assert.equal(upload.statusCode, 200, upload.body);
    const { fileId } = upload.json();
    const confirmation = await app.inject({ method: 'POST', url: '/api/files/' + fileId + '/confirm' });
    assert.equal(confirmation.json().status, 'ready');
    assert.equal(confirmation.json().entityId, 'task');
    db.run('UPDATE files SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', fileId);
    return fileId as string;
  }
  const staged = await stage();
  const bound = await stage();
  bindAttachments(db, [bound], 'task');
  const key = db.get('SELECT object_key FROM files WHERE id=?', staged).object_key;
  assert.equal(await cleanupFiles(db, storage), 1);
  assert.deepEqual(removed, [key]);
  assert.equal(db.get('SELECT id FROM files WHERE id=?', staged), undefined);
  assert.equal(db.get('SELECT status FROM files WHERE id=?', bound).status, 'ready');
});

test('cleanup retries objects left in cleaning when the storage delete fails', async t => {
  let attempts = 0;
  const { app, db, storage } = await setup(manager, true, {
    remove: async () => { if (++attempts === 1) throw new Error('temporary storage failure'); },
  });
  t.after(async () => { await app.close(); db.close(); });
  db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,created_at,expires_at) VALUES('staged','r.pdf',20,'application/pdf','staged','receipt','payment','m','ready',?,?)",
    date, '2000-01-01T00:00:00.000Z');
  await assert.rejects(cleanupFiles(db, storage), /temporary storage failure/);
  assert.equal(db.get("SELECT status FROM files WHERE id='staged'").status, 'cleaning');
  assert.equal(await cleanupFiles(db, storage), 1);
  assert.equal(attempts, 2);
  assert.equal(db.get("SELECT id FROM files WHERE id='staged'"), undefined);
});

test('submission bundles sanitize dot-only and control-character folder names', async t => {
  let output: Buffer | undefined;
  const content = Buffer.from('%PDF-1.7');
  const { app, db } = await setup(manager, true, {
    read: async () => content,
    put: async (_key, buffer) => { output = buffer; },
  });
  t.after(async () => { await app.close(); db.close(); });
  db.run("INSERT INTO tasks(id,kind,title,author_id,created_at,updated_at) VALUES('task','homework','作业','m',?,?)", date, date);
  db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,created_at) VALUES('submission','r.pdf',?,'application/pdf','submission','submission','task','s','ready',?)",
    content.length, date);
  db.run("INSERT INTO submissions(id,task_id,user_id,attachments,task_title,version,created_at) VALUES('answer','task','s',?,'作业',1,?)",
    '["submission"]', date);
  for (const displayName of ['.', '..', '.. ', '同学\x00\x1f\x7f']) {
    db.run("UPDATE users SET name=? WHERE id='s'", displayName);
    await createBundle(db, manager, ['submission'], '附件', { kind: 'task', id: 'task' });
    assert.ok(output);
    const zip = await JSZip.loadAsync(output);
    const files = Object.values(zip.files).filter(entry => !entry.dir);
    assert.equal(files.length, 1);
    const entry = files[0];
    const [folder, filename, extra] = entry.name.split('/');
    assert.equal(entry.unsafeOriginalName, entry.name);
    assert.ok(folder && !/^\.+\s*$/.test(folder) && !/\p{Cc}/u.test(folder));
    assert.equal(filename, '1-r.pdf');
    assert.equal(extra, undefined);
    assert.deepEqual(await entry.async('nodebuffer'), content);
  }
});
