import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { User } from '../server/common.ts';
import { createStore } from '../server/db.ts';
import { registerFiles, type StorageAdapter } from '../server/files.ts';
import { registerFinance } from '../server/finance.ts';
import type { Permission } from '../shared/permissions.ts';

const date = '2026-11-09';
const writes = ['finance.entries.create', 'finance.entries.edit', 'finance.entries.void',
  'finance.fees.create', 'finance.fees.edit', 'finance.payments.create', 'finance.payments.edit', 'finance.payments.void'] as const;

function fixture(t: TestContext, grants: Permission[] = []) {
  const db = createStore();
  const app = Fastify();
  const users: User[] = [
    { id: randomUUID(), username: 'admin', name: '受限管理员', role: 'admin', financeManage: true, inClass: false, permissions: grants, active: true, version: 1, mustChangePassword: false },
    { id: randomUUID(), username: 'cashier', name: '出纳', role: 'committee', financeManage: true, inClass: true, permissions: [], active: true, version: 1, mustChangePassword: false },
    { id: randomUUID(), username: 'student', name: '甲同学', role: 'student', financeManage: false, inClass: true, permissions: [], active: true, version: 1, mustChangePassword: false },
    { id: randomUUID(), username: 'committee', name: '普通班委', role: 'committee', financeManage: false, inClass: true, permissions: [], active: true, version: 1, mustChangePassword: false },
  ];
  for (const user of users) db.run('INSERT INTO users(id,username,name,password_hash,role,finance_manage,in_class,must_change_password,permissions,created_at) VALUES(?,?,?,?,?,?,?,0,?,?)',
    user.id, user.username, user.name, 'test', user.role, Number(user.financeManage), Number(user.inClass),JSON.stringify(user.permissions??[]),date);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async req => { req.user = users.find(user => user.username === req.headers['x-test-user']) ?? null; });
  registerFinance(app, db);
  registerFiles(app, db, {
    configured: true, uploadUrl: async () => ({ url: 'https://upload.example', headers: {} }),
    head: async () => ({ size: 5, mime: 'image/png' }), readHead: async () => Buffer.alloc(5),
    downloadUrl: async () => 'https://download.example', put: async () => {}, remove: async () => {},
  } satisfies StorageAdapter);
  t.after(async () => { await app.close(); db.close(); });
  const [admin, cashier, student, committee] = users;
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, who = 'admin') {
    const result = await app.inject({ method, url: '/api/finance' + path, payload, headers: { 'x-test-user': who } });
    return { status: result.statusCode, data: result.json() };
  }
  const entry = () => ({ type: 'expense', amount: 450, category: '班级用品', description: '采购', date, receiptIds: [], publicReceipt: false, idempotencyKey: randomUUID() });
  const fee = { title: '活动', amount: 1000, deadline: null, userIds: [student.id] };
  const payment = (feeId: string) => ({ feeId, userId: student.id, amount: 700, date, description: '甲同学私有明细', receiptIds: [], publicReceipt: false, idempotencyKey: randomUUID() });
  async function seed() {
    const e = await call('POST', '/entries', entry(), 'cashier');
    const f = await call('POST', '/fees', fee, 'cashier');
    const p = await call('POST', '/payments', payment(f.data.id), 'cashier');
    for (const result of [e, f, p]) assert.equal(result.status, 200, JSON.stringify(result.data));
    return { entryId: e.data.id, feeId: f.data.id, paymentId: p.data.id };
  }
  return { db, app, call, admin, cashier, student, committee, entry, fee, payment, seed };
}

test('ungranted administrators keep public ledger access but cannot see private payments or use legacy finance flag', async t => {
  const f = fixture(t);
  await f.seed();
  const result = await f.call('GET', '');
  assert.equal(result.status, 200);
  assert.equal(result.data.canViewAll, false);
  assert.equal(result.data.canManage, false);
  assert.deepEqual(result.data.payments, []);
  assert.deepEqual(result.data.fees, []);
  assert.ok(result.data.entries.every((entry: { paymentId: string | null }) => entry.paymentId === null));
  assert.ok(!JSON.stringify(result.data).includes('甲同学私有明细'));
  for (const path of ['/members', '/history']) assert.equal((await f.call('GET', path)).status, 403);
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 403);
  assert.equal((await f.call('POST', '/export', {})).status, 403);
  delete f.admin.permissions;
  f.db.run("UPDATE users SET permissions='[]' WHERE id=?",f.admin.id);
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 403, 'missing grants also fail closed');
});

test('full finance read does not imply history, export or any mutation', async t => {
  const f = fixture(t, ['finance.read']);
  const ids = await f.seed();
  const result = await f.call('GET', '');
  assert.equal(result.data.canViewAll, true);
  assert.equal(result.data.canManage, false);
  assert.equal(result.data.payments[0].description, '甲同学私有明细');
  assert.deepEqual(result.data.fees[0].userIds, [f.student.id]);
  assert.equal((await f.call('GET', '/members')).status, 200);
  assert.equal((await f.call('GET', '/history')).status, 403);
  assert.equal((await f.call('POST', '/export', {})).status, 403);
  assert.equal((await f.call('PUT', '/entries/' + ids.entryId, { amount: 900, version: 1, reason: '测试' })).status, 403);
  assert.equal((await f.call('POST', '/payments', f.payment(ids.feeId))).status, 403);
  assert.equal((await f.call('POST', '/fees', f.fee)).status, 403);
  assert.equal(f.db.get<{ amount: number }>('SELECT amount FROM finance_entries WHERE id=?', ids.entryId)?.amount, 450);
});

for (const grant of writes) test(`${grant} authorizes only its exact mutation`, async t => {
  const f = fixture(t, ['finance.read', grant]);
  const ids = await f.seed();
  const operations: { permission: Permission; method: 'POST' | 'PUT'; path: string; body: object }[] = [
    { permission: 'finance.entries.create', method: 'POST', path: '/entries', body: f.entry() },
    { permission: 'finance.entries.edit', method: 'PUT', path: '/entries/' + ids.entryId, body: { amount: 900, version: 1, reason: '调整' } },
    { permission: 'finance.entries.void', method: 'POST', path: '/entries/' + ids.entryId + '/void', body: { version: 1, reason: '作废' } },
    { permission: 'finance.fees.create', method: 'POST', path: '/fees', body: f.fee },
    { permission: 'finance.fees.edit', method: 'PUT', path: '/fees/' + ids.feeId, body: { ...f.fee, amount: 1200, version: 1 } },
    { permission: 'finance.payments.create', method: 'POST', path: '/payments', body: f.payment(ids.feeId) },
    { permission: 'finance.payments.edit', method: 'PUT', path: '/payments/' + ids.paymentId, body: { amount: 800, version: 1, reason: '调整' } },
    { permission: 'finance.payments.void', method: 'POST', path: '/payments/' + ids.paymentId + '/void', body: { version: 1, reason: '作废' } },
  ];
  for (const operation of operations) {
    const result = await f.call(operation.method, operation.path, operation.body);
    assert.equal(result.status, operation.permission === grant ? 200 : 403, operation.permission + ': ' + JSON.stringify(result.data));
  }
  assert.equal((await f.call('GET', '/history')).status, 403);
  assert.equal((await f.call('POST', '/export', {})).status, 403);
});

test('history grant reads revisions without authorizing exports or writes', async t => {
  const f = fixture(t, ['finance.read', 'finance.history']);
  const ids = await f.seed();
  await f.call('PUT', '/entries/' + ids.entryId, { amount: 900, version: 1, reason: '核对' }, 'cashier');
  const history = await f.call('GET', '/history');
  assert.equal(history.status, 200);
  assert.equal(history.data[0].data.amount, 450);
  assert.equal((await f.call('POST', '/export', {})).status, 403);
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 403);
});

test('export grant generates a scoped workbook without history or writes', async t => {
  const f = fixture(t, ['finance.read', 'finance.export']);
  await f.seed();
  const result = await f.call('POST', '/export', {});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const file = f.db.get<{ scope: string }>('SELECT scope FROM files WHERE id=?', result.data.fileId)!;
  assert.deepEqual(JSON.parse(file.scope), { kind: 'finance', permission: 'finance.export' });
  assert.equal((await f.call('GET', '/history')).status, 403);
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 403);
});

test('write, history and export grants without their full-read dependency fail closed', async t => {
  const f = fixture(t, [...writes, 'finance.history', 'finance.export']);
  assert.equal((await f.call('GET', '')).data.canViewAll, false);
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 403);
  assert.equal((await f.call('POST', '/fees', f.fee)).status, 403);
  assert.equal((await f.call('GET', '/history')).status, 403);
  assert.equal((await f.call('POST', '/export', {})).status, 403);
});

test('committee finance capability follows the flag and revocation also blocks retries', async t => {
  const f = fixture(t);
  assert.equal((await f.call('GET', '', undefined, 'committee')).data.canViewAll, false);
  assert.equal((await f.call('POST', '/entries', f.entry(), 'committee')).status, 403);
  const input = f.entry();
  assert.equal((await f.call('POST', '/entries', input, 'cashier')).status, 200);
  f.cashier.financeManage = false;
  f.db.run('UPDATE users SET finance_manage=0 WHERE id=?',f.cashier.id);
  assert.equal((await f.call('GET', '', undefined, 'cashier')).data.canViewAll, false);
  assert.equal((await f.call('POST', '/entries', input, 'cashier')).status, 403);
});

test('Admin can use finance without explicit grants and joins fee rosters only when included', async t => {
  const f = fixture(t);
  f.admin.role = 'super_admin';
  f.db.run("UPDATE users SET role='super_admin' WHERE id=?", f.admin.id);
  let roster = await f.call('GET', '/members');
  assert.equal(roster.status, 200);
  assert.deepEqual(new Set(roster.data.map((member: { id: string }) => member.id)), new Set([f.cashier.id, f.committee.id, f.student.id]));
  assert.equal((await f.call('POST', '/fees', { ...f.fee, userIds: [f.admin.id] })).status, 400);
  f.db.run('UPDATE users SET in_class=1 WHERE id=?', f.admin.id);
  roster = await f.call('GET', '/members');
  assert.ok(roster.data.some((member: { id: string }) => member.id === f.admin.id));
  const fee = await f.call('POST', '/fees', { ...f.fee, userIds: [f.admin.id] });
  assert.equal(fee.status, 200, JSON.stringify(fee.data));
  const payment = await f.call('POST', '/payments', { ...f.payment(fee.data.id), userId: f.admin.id });
  assert.equal(payment.status, 200, JSON.stringify(payment.data));
  assert.equal((await f.call('POST', '/entries', f.entry())).status, 200);
  assert.equal((await f.call('GET', '')).data.canViewAll, true);
  assert.equal((await f.call('GET', '/history')).status, 200);
  assert.equal((await f.call('POST', '/export', {})).status, 200);
});

test('revoking an administrator write grant blocks its replay without removing granted reads', async t => {
  const f = fixture(t, ['finance.read', 'finance.entries.create']);
  const input = f.entry();
  const created = await f.call('POST', '/entries', input);
  assert.equal(created.status, 200);
  f.admin.permissions = ['finance.read'];
  f.db.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(f.admin.permissions),f.admin.id);
  assert.equal((await f.call('POST', '/entries', input)).status, 403);
  assert.equal((await f.call('GET', '')).data.canViewAll, true);
  assert.equal(f.db.get<{ total: number }>('SELECT count(*) AS total FROM finance_entries')?.total, 1);
});
