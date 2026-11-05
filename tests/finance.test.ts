import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import type { User } from '../server/common.ts';
import { createStore } from '../server/db.ts';
import { registerFiles, type StorageAdapter } from '../server/files.ts';
import { registerFinance } from '../server/finance.ts';

const base = '/api/finance';
const date = '2026-11-06';

function fixture(t: TestContext, storage?: StorageAdapter) {
  const db = createStore();
  const app = Fastify();
  const users = new Map<string, User>();
  for (const [name, role, financeManage] of [
    ['出纳', 'committee', true], ['班委', 'committee', false],
    ['甲同学', 'student', false], ['乙同学', 'student', false], ['管理员', 'admin', false],
  ] as const) {
    const id = randomUUID();
    users.set(name, { id, username: id, name, role, financeManage, active: true, version: 1, mustChangePassword: false });
    db.run('INSERT INTO users(id,username,name,password_hash,role,finance_manage,must_change_password,created_at) VALUES(?,?,?,?,?,?,0,?)',
      id, id, name, 'test', role, Number(financeManage), date);
  }
  app.decorateRequest('user', null);
  app.addHook('onRequest', async req => { req.user = [...users.values()].find(user => user.id === req.headers['x-test-user']) ?? null; });
  registerFinance(app, db);
  registerFiles(app, db, storage);
  t.after(async () => { await app.close(); db.close(); });
  const student = users.get('甲同学')!.id;
  const other = users.get('乙同学')!.id;
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, who = '出纳') {
    const response = await app.inject({
      method, url: path.startsWith('/api/') ? path : base + path, payload, headers: { 'x-test-user': users.get(who)?.id ?? '' },
    });
    return { status: response.statusCode, data: response.json() };
  }
  async function fee() {
    const response = await call('POST', '/fees', { title: '班级活动', amount: 2500, deadline: null, userIds: [student, other] });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.id as string;
  }
  function payment(feeId: string, overrides?: object) {
    return { feeId, userId: student, amount: 1000, date, description: '甲同学分次缴费', receiptIds: [], idempotencyKey: randomUUID(), ...overrides };
  }
  return { call, fee, payment, users, db, student, other };
}

function testStorage(put: StorageAdapter['put'] = async () => {}) {
  return {
    configured: true,
    uploadUrl: async () => ({ url: 'https://upload.example', headers: {} }),
    head: async () => ({ size: 5, mime: 'image/png' }),
    readHead: async () => Buffer.alloc(5),
    downloadUrl: async () => 'https://download.example',
    put,
    remove: async () => {},
  } satisfies StorageAdapter;
}

test('partial payments post once per idempotency key, with overpayment recorded in full', async t => {
  const { call, fee, payment } = fixture(t);
  const feeId = await fee();
  assert.equal((await call('GET', '')).data.balance, 0);
  const request = payment(feeId);
  const [first, retry] = await Promise.all([call('POST', '/payments', request), call('POST', '/payments', request)]);
  assert.equal(first.status, 200);
  assert.equal(retry.data.id, first.data.id);
  assert.equal((await call('POST', '/payments', { ...request, amount: 1100 })).status, 409);
  assert.equal((await call('POST', '/payments', payment(feeId, { amount: 1700 }))).status, 200);
  const { data } = await call('GET', '');
  assert.equal(data.income, 2700);
  assert.equal(data.balance, 2700);
  assert.equal(data.entries.length, 2);
  assert.equal(data.payments.length, 2);
});

test('payment updates and voids atomically revise the linked income and retain audit history', async t => {
  const { call, fee, payment } = fixture(t);
  const feeId = await fee();
  const created = await call('POST', '/payments', payment(feeId));
  const { id } = created.data;
  const entry = (await call('GET', '')).data.entries[0];
  assert.equal((await call('PUT', '/entries/' + entry.id, { amount: 100, version: 1, reason: '修正' })).status, 409);
  const revision = { amount: 850, version: 1, reason: '核对实收' };
  const corrected = await call('PUT', '/payments/' + id, revision);
  assert.equal(corrected.data.version, 2);
  assert.deepEqual(await call('PUT', '/payments/' + id, revision), corrected);
  assert.equal((await call('PUT', '/payments/' + id, { ...revision, amount: 950 })).status, 409);
  let summary = (await call('GET', '')).data;
  assert.equal(summary.balance, 850);
  assert.equal(summary.entries[0].version, 2);
  assert.equal(summary.entries[0].amount, 850);
  const voidInput = { version: 2, reason: '已退款' };
  const voided = await call('POST', '/payments/' + id + '/void', voidInput);
  assert.equal(voided.data.voided, true);
  assert.deepEqual(await call('POST', '/payments/' + id + '/void', voidInput), voided);
  assert.deepEqual(await call('PUT', '/payments/' + id, revision), corrected);
  summary = (await call('GET', '')).data;
  assert.equal(summary.balance, 0);
  assert.equal(summary.entries[0].voided, true);
  assert.equal(summary.entries[0].version, 3);
  const history = (await call('GET', '/history')).data;
  const edited = history.find((row: { entityId: string; reason: string }) => row.entityId === id && row.reason === '核对实收');
  assert.equal(edited.action, 'update');
  assert.equal(edited.actorName, '出纳');
  assert.equal(edited.data.amount, 1000);
  const removed = history.find((row: { entityId: string; reason: string }) => row.entityId === id && row.reason === '已退款');
  assert.equal(removed.action, 'void');
  assert.equal(removed.data.amount, 850);
});

test('ledger totals include one active opening, independent income and expenses', async t => {
  const { call } = fixture(t);
  const entry = { category: '其他', description: '', date, receiptIds: [], publicReceipt: false };
  const opening = await call('POST', '/entries', { ...entry, type: 'opening', amount: 10000, idempotencyKey: 'opening' });
  assert.equal(opening.status, 200);
  assert.equal((await call('POST', '/entries', { ...entry, type: 'opening', amount: 10000, idempotencyKey: 'duplicate' })).status, 409);
  assert.equal((await call('POST', '/entries', { ...entry, type: 'income', amount: 1200, idempotencyKey: 'income' })).status, 200);
  assert.equal((await call('POST', '/entries', { ...entry, type: 'expense', amount: 2100, idempotencyKey: 'expense' })).status, 200);
  assert.equal((await call('POST', '/entries', { ...entry, type: 'expense', amount: 0, idempotencyKey: 'zero' })).status, 400);
  assert.equal((await call('POST', '/entries', { ...entry, type: 'expense', amount: 123.4, idempotencyKey: 'fraction' })).status, 400);
  assert.equal((await call('PUT', '/entries/' + opening.data.id, { amount: 12000, version: 1, reason: '更正期初' })).status, 200);
  const { opening: totalOpening, income, expense, balance } = (await call('GET', '')).data;
  assert.deepEqual([totalOpening, income, expense, balance], [12000, 1200, 2100, 11100]);
});

test('finance roles enforce write access and redact individual payments from the class ledger', async t => {
  const { call, fee, payment, db, users, student, other } = fixture(t, testStorage());
  const feeId = await fee();
  const receiptId = randomUUID();
  db.run("INSERT INTO files(id,name,size,mime,object_key,purpose,owner_id,status,created_at) VALUES(?,?,5,'image/png',?,'receipt',?,'ready',?)",
    receiptId, 'receipt.png', receiptId, users.get('出纳')!.id, date);
  const first = await call('POST', '/payments', payment(feeId, { receiptIds: [receiptId] }));
  assert.equal(first.status, 200);
  assert.equal((await call('POST', '/payments', payment(feeId, { userId: other, description: '乙同学实缴' }))).status, 200);
  const own = (await call('GET', '', undefined, '甲同学')).data;
  const receiptDownload = '/api/files/' + receiptId + '/download';
  assert.equal((await call('POST', receiptDownload, {}, '甲同学')).status, 403);
  assert.deepEqual(own.payments.map((row: { userId: string }) => row.userId), [student]);
  assert.deepEqual(own.payments[0].receiptIds, []);
  assert.deepEqual(own.fees[0].userIds, [student]);
  for (const entry of own.entries) {
    assert.equal(entry.paymentId, null);
    assert.equal(entry.description, '班费收入');
    assert.deepEqual(entry.receiptIds, []);
  }
  const admin = (await call('GET', '', undefined, '管理员')).data;
  assert.equal(admin.canManage, false);
  assert.equal(admin.canViewAll, true);
  assert.deepEqual(admin.payments.find((row: { id: string }) => row.id === first.data.id).receiptIds, [receiptId]);
  assert.equal((await call('PUT', '/payments/' + first.data.id, { publicReceipt: true, version: 1, reason: '公示凭证' })).status, 200);
  const published = (await call('GET', '', undefined, '乙同学')).data;
  assert.ok(published.entries.some((entry: { receiptIds: string[] }) => entry.receiptIds.includes(receiptId)));
  assert.equal(published.payments.length, 1);
  assert.equal((await call('POST', receiptDownload, {}, '乙同学')).status, 200);
  assert.equal((await call('PUT', '/payments/' + first.data.id, { receiptIds: [], version: 2, reason: '移除凭证' })).status, 200);
  assert.equal((await call('POST', receiptDownload, {}, '乙同学')).status, 403);
  for (const who of ['管理员', '班委', '甲同学']) {
    assert.equal((await call('POST', '/payments', payment(feeId), who)).status, 403);
  }
  assert.equal((await call('GET', '/history', undefined, '甲同学')).status, 403);
  assert.equal((await call('POST', '/export', {}, '班委')).status, 403);
  assert.equal((await call('GET', '', undefined, '游客')).status, 401);
});

test('a rejected payment rolls back both ledger records and leaves the key reusable', async t => {
  const { call, fee, payment } = fixture(t);
  const feeId = await fee();
  const opening = await call('POST', '/entries', {
    type: 'opening', amount: Number.MAX_SAFE_INTEGER, category: '', description: '', date, receiptIds: [],
    publicReceipt: false, idempotencyKey: 'opening',
  });
  assert.equal(opening.status, 200);
  const input = payment(feeId, { amount: 1 });
  assert.equal((await call('POST', '/payments', input)).status, 400);
  const before = (await call('GET', '')).data;
  assert.equal(before.entries.length, 1);
  assert.deepEqual(before.payments, []);
  assert.equal((await call('POST', '/entries/' + opening.data.id + '/void', { version: 1, reason: '更正期初' })).status, 200);
  assert.equal((await call('POST', '/payments', input)).status, 200);
  assert.equal((await call('GET', '')).data.balance, 1);
});

test('authorized export writes an XLSX with numeric cents and individual payment rows', async t => {
  let output: Buffer | undefined;
  const storage = testStorage(async (_key, buffer) => { output = buffer; });
  const { call, fee, payment } = fixture(t, storage);
  const feeId = await fee();
  assert.equal((await call('POST', '/payments', payment(feeId, { amount: 1001 }))).status, 200);
  const exported = await call('POST', '/export', {}, '管理员');
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  assert.ok(exported.data.fileId);
  assert.ok(output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(output).buffer);
  assert.equal(workbook.getWorksheet('余额总览')?.getCell('D2').value, 1001);
  assert.equal(workbook.getWorksheet('个人缴费登记')?.getCell('D2').value, '甲同学');
  assert.equal(workbook.getWorksheet('个人缴费登记')?.getCell('E2').value, 1001);
  const download = '/api/files/' + exported.data.fileId + '/download';
  assert.equal((await call('POST', download, {}, '管理员')).status, 200);
  assert.equal((await call('POST', download, {}, '甲同学')).status, 403);
});
