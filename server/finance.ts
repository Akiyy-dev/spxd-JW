import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canManageFinance, conflict, dateSchema, HttpError, json, now, parse, requireFinance, requireUser, uid, versionSchema, type User } from './common.ts';
import type { Store } from './db.ts';
import { bindAttachments, createExport, validateAttachments } from './files.ts';

const base = '/api/finance';
const idSchema = z.string().uuid();
const ids = z.array(idSchema).refine(values => new Set(values).size === values.length, '不能重复选择');
const amountSchema = z.number().int().positive();
const reasonSchema = z.string().trim().min(1).max(1000);
const idempotencyKey = z.string().trim().min(1).max(200);
const entryFields = z.object({
  type: z.enum(['opening', 'income', 'expense']),
  amount: amountSchema,
  category: z.string().trim().max(100),
  description: z.string().trim().max(2000),
  date: dateSchema,
  receiptIds: ids,
  publicReceipt: z.boolean(),
});
const paymentFields = z.object({
  feeId: idSchema, userId: idSchema, amount: amountSchema, date: dateSchema,
  description: entryFields.shape.description, receiptIds: ids, publicReceipt: z.boolean(),
});
const feeFields = z.object({
  title: z.string().trim().min(1).max(150),
  amount: amountSchema, deadline: dateSchema.nullable(), userIds: ids,
});
const createEntry = entryFields.extend({ idempotencyKey });
const createPayment = paymentFields.extend({ idempotencyKey, publicReceipt: z.boolean().default(false) });
const revisionFields = { version: versionSchema, reason: reasonSchema };
const updateEntry = entryFields.partial().extend(revisionFields);
const updatePayment = paymentFields.partial().extend(revisionFields);
const updateFee = feeFields.extend({ version: versionSchema });
const voidFields = z.object(revisionFields);

type Entry = z.infer<typeof entryFields> & {
  id: string; paymentId: string | null; voided: boolean; version: number; createdAt: string; authorName: string;
};
type Payment = z.infer<typeof paymentFields> & {
  id: string; name: string; voided: boolean; version: number;
};
type Fee = z.infer<typeof feeFields> & { id: string; version: number; createdAt: string };
type EntryRow = Omit<Entry, 'receiptIds' | 'publicReceipt' | 'voided'> & {
  receiptIds: string; publicReceipt: number; voided: number; authorId: string;
};
type PaymentRow = Omit<Payment, 'receiptIds' | 'publicReceipt' | 'voided'> & {
  receiptIds: string; publicReceipt: number | null; voided: number; authorId: string;
};
type FeeRow = Omit<Fee, 'userIds'> & { userIds: string };
type RevisionAction = 'update' | 'void';
type Revision<T> = { before: T; action: RevisionAction; request?: string };
type Entity = Entry | Payment | Fee;
type EntityType = 'entry' | 'payment' | 'fee';

const entriesSql = `SELECT e.id,e.type,e.amount,e.category,e.description,e.date,e.receipt_ids AS receiptIds,
  e.public_receipt AS publicReceipt,e.payment_id AS paymentId,e.voided,e.version,e.created_at AS createdAt,
  e.author_id AS authorId,u.name AS authorName FROM finance_entries e JOIN users u ON e.author_id=u.id`;
const paymentsSql = `SELECT p.id,p.fee_id AS feeId,p.user_id AS userId,u.name,p.amount,p.date,p.description,
  p.receipt_ids AS receiptIds,e.public_receipt AS publicReceipt,p.version,p.voided,p.author_id AS authorId
  FROM payments p JOIN users u ON p.user_id=u.id LEFT JOIN finance_entries e ON p.id=e.payment_id`;
const feesSql = 'SELECT id,title,amount,deadline,user_ids AS userIds,version,created_at AS createdAt FROM fees';

function entryView({ authorId: _authorId, ...row }: EntryRow): Entry {
  return { ...row, receiptIds: json<string[]>(row.receiptIds, []), publicReceipt: !!row.publicReceipt, voided: !!row.voided };
}
function paymentView({ authorId: _authorId, ...row }: PaymentRow): Payment {
  return { ...row, receiptIds: json<string[]>(row.receiptIds, []), publicReceipt: !!row.publicReceipt, voided: !!row.voided };
}
function feeView(row: FeeRow): Fee {
  return { ...row, userIds: json<string[]>(row.userIds, []) };
}
function found<T>(value: T | undefined): T {
  if (value === undefined) throw new HttpError(404, '记录不存在');
  return value;
}
const getEntry = (db: Store, id: string) => entryView(found(db.get<EntryRow>(entriesSql + ' WHERE e.id=?', id)));
const getPayment = (db: Store, id: string) => paymentView(found(db.get<PaymentRow>(paymentsSql + ' WHERE p.id=?', id)));
const getFee = (db: Store, id: string) => feeView(found(db.get<FeeRow>(feesSql + ' WHERE id=?', id)));
const linkedEntry = (db: Store, paymentId: string) => entryView(found(db.get<EntryRow>(entriesSql + ' WHERE e.payment_id=?', paymentId)));
const getId = (req: FastifyRequest) => parse(z.object({ id: idSchema }), req.params).id;
const canViewAll = canManageFinance;

function requireFinanceReader(req: FastifyRequest) {
  const user = requireUser(req);
  if (!canViewAll(user)) throw new HttpError(403, '需要完整班费查阅权限');
  return user;
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function revisionAt<T extends Entity>(db: Store, type: EntityType, id: string, version: number) {
  const row = db.get<{ data: string; actor_id: string }>(
    'SELECT data,actor_id FROM finance_versions WHERE entity_type=? AND entity_id=? AND version=?',
    type, id, version);
  return row && { ...json<Revision<T> | null>(row.data, null), actorId: row.actor_id };
}

function saveRevision(db: Store, user: User, type: EntityType, before: Entity, action: RevisionAction, reason: string, request?: string) {
  db.run('INSERT INTO finance_versions(id,entity_type,entity_id,data,version,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
    uid(), type, before.id, JSON.stringify({ before, action, request }), before.version, reason, user.id, now());
}

function replayRevision<T extends Entity>(db: Store, user: User, type: EntityType, current: T, version: number, request: string) {
  if (current.version === version) return;
  const revision = revisionAt<T>(db, type, current.id, version);
  if (revision?.request === request && revision.actorId === user.id) {
    return revisionAt<T>(db, type, current.id, version + 1)?.before ?? current;
  }
  conflict(current.version, version);
}

function replayCreate<T extends Entity>(db: Store, type: EntityType, originalAuthor: string, user: User, current: T, request: string) {
  const audit = db.get<{ details: string }>('SELECT details FROM audit WHERE action=? AND entity_id=?',
    'finance.' + type + '.create', current.id);
  if (originalAuthor !== user.id || json<{ request?: string }>(audit?.details, {}).request !== request) {
    throw new HttpError(409, '该幂等键已被其他登记使用');
  }
  return revisionAt<T>(db, type, current.id, 1)?.before ?? current;
}

function assertOpening(db: Store, type: Entry['type'], id = '') {
  if (type === 'opening' && db.get("SELECT id FROM finance_entries WHERE type='opening' AND voided=0 AND id<>?", id)) {
    throw new HttpError(409, '已有生效的期初记录，请修订现有记录');
  }
}

function assertMember(db: Store, id: string) {
  if (!db.get("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('student','committee')", id)) {
    throw new HttpError(400, '缴费对象必须是启用的学生或班委');
  }
}

function assertPayer(db: Store, feeId: string, userId: string) {
  assertMember(db, userId);
  if (!getFee(db, feeId).userIds.includes(userId)) throw new HttpError(400, '该成员不属于此缴费事项');
}

function assertActive(entity: Entry | Payment) {
  if (entity.voided) throw new HttpError(409, '记录已作废');
}

function assertManual(entry: Entry) {
  if (entry.paymentId) throw new HttpError(409, '请在关联的缴费登记中修改此笔收入');
  assertActive(entry);
}

function ledgerTotals(entries: Entry[]) {
  const totals = { opening: 0, income: 0, expense: 0 };
  for (const entry of entries) {
    if (!entry.voided) totals[entry.type] += entry.amount;
  }
  return { ...totals, balance: totals.opening + (totals.income - totals.expense) };
}

function assertSafeTotals(db: Store) {
  const totals = ledgerTotals(db.all<EntryRow>(entriesSql + ' WHERE e.voided=0').map(entryView));
  if (!Object.values(totals).every(Number.isSafeInteger)) throw new HttpError(400, '台账合计超出金额范围');
}

function readFinance(db: Store, user: User) {
  const full = canViewAll(user);
  const ledger = db.all<EntryRow>(entriesSql + ' ORDER BY e.date DESC,e.created_at DESC,e.id DESC').map(entryView);
  const paymentFilter = full ? [] : [user.id];
  const payments = db.all<PaymentRow>(paymentsSql + (full ? '' : ' WHERE p.user_id=?')
    + ' ORDER BY p.date DESC,p.created_at DESC,p.id DESC', ...paymentFilter)
    .map(paymentView)
    .map(payment => full || (payment.publicReceipt && !payment.voided) ? payment : { ...payment, receiptIds: [] });
  const paidFeeIds = new Set(payments.map(payment => payment.feeId));
  const fees = db.all<FeeRow>(feesSql + ' ORDER BY createdAt DESC,id DESC').map(feeView)
    .filter(fee => full || fee.userIds.includes(user.id) || paidFeeIds.has(fee.id))
    .map(fee => full ? fee : { ...fee, userIds: fee.userIds.filter(id => id === user.id) });
  const entries = full ? ledger : ledger.filter(entry => !entry.voided).map(entry => ({
    ...entry,
    ...(entry.paymentId && { paymentId: null, category: '班费收入', description: '班费收入', authorName: '' }),
    receiptIds: entry.publicReceipt ? entry.receiptIds : [],
  }));
  return { ...ledgerTotals(ledger), entries, fees, payments, canManage: canManageFinance(user), canViewAll: full };
}

function insertEntry(db: Store, user: User, id: string, fields: z.infer<typeof entryFields>, key: string | null, paymentId: string | null) {
  db.run(`INSERT INTO finance_entries(id,type,amount,category,description,date,receipt_ids,public_receipt,payment_id,idempotency_key,author_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, fields.type, fields.amount, fields.category, fields.description, fields.date,
    JSON.stringify(fields.receiptIds), Number(fields.publicReceipt), paymentId, key, user.id, now());
}

function saveEntry(db: Store, entry: Entry) {
  db.run(`UPDATE finance_entries SET type=?,amount=?,category=?,description=?,date=?,receipt_ids=?,public_receipt=?,voided=?,version=version+1
    WHERE id=?`, entry.type, entry.amount, entry.category, entry.description, entry.date,
    JSON.stringify(entry.receiptIds), Number(entry.publicReceipt), Number(entry.voided), entry.id);
}

export function registerFinance(app: FastifyInstance, db: Store) {
  app.get(base, req => readFinance(db, requireUser(req)));

  app.get(base + '/members', req => {
    requireFinanceReader(req);
    return db.all("SELECT id,name FROM users WHERE active=1 AND role IN ('student','committee') ORDER BY name,id");
  });

  app.get(base + '/history', req => {
    requireFinanceReader(req);
    const rows = db.all<{ id: string; entityType: EntityType; entityId: string; data: string; version: number; reason: string; actorId: string; actorName: string; createdAt: string }>(
      `SELECT v.id,v.entity_type AS entityType,v.entity_id AS entityId,v.data,v.version,v.reason,
        v.actor_id AS actorId,u.name AS actorName,v.created_at AS createdAt FROM finance_versions v
        JOIN users u ON v.actor_id=u.id ORDER BY v.created_at DESC,v.rowid DESC`);
    return rows.map(({ data, ...row }) => {
      const snapshot = json<Revision<Entity> | Entity | null>(data, null);
      if (snapshot && 'before' in snapshot) return { ...row, action: snapshot.action, data: snapshot.before };
      return { ...row, action: null, data: snapshot };
    });
  });

  app.post(base + '/entries', req => {
    const user = requireFinance(req);
    const input = parse(createEntry, req.body);
    const request = fingerprint(input);
    return db.transaction(() => {
      const existing = db.get<EntryRow>(entriesSql + ' WHERE e.idempotency_key=?', input.idempotencyKey);
      if (existing) return replayCreate(db, 'entry', existing.authorId, user, entryView(existing), request);
      const id = uid();
      assertOpening(db, input.type);
      validateAttachments(db, user, input.receiptIds, 'receipt', id);
      insertEntry(db, user, id, input, input.idempotencyKey, null);
      bindAttachments(db, input.receiptIds, id);
      assertSafeTotals(db);
      db.audit(user.id, 'finance.entry.create', id, { request });
      return getEntry(db, id);
    });
  });

  app.put(base + '/entries/:id', req => {
    const user = requireFinance(req);
    const id = getId(req);
    const { version, reason, ...changes } = parse(updateEntry, req.body);
    const request = fingerprint({ action: 'update', reason, changes });
    return db.transaction(() => {
      const current = getEntry(db, id);
      const replay = replayRevision(db, user, 'entry', current, version, request);
      if (replay) return replay;
      assertManual(current);
      const next = { ...current, ...changes };
      assertOpening(db, next.type, id);
      validateAttachments(db, user, next.receiptIds, 'receipt', id);
      saveRevision(db, user, 'entry', current, 'update', reason, request);
      saveEntry(db, next);
      bindAttachments(db, next.receiptIds, id);
      assertSafeTotals(db);
      return getEntry(db, id);
    });
  });

  app.post(base + '/entries/:id/void', req => {
    const user = requireFinance(req);
    const id = getId(req);
    const { version, reason } = parse(voidFields, req.body);
    const request = fingerprint({ action: 'void', reason });
    return db.transaction(() => {
      const current = getEntry(db, id);
      const replay = replayRevision(db, user, 'entry', current, version, request);
      if (replay) return replay;
      assertManual(current);
      saveRevision(db, user, 'entry', current, 'void', reason, request);
      saveEntry(db, { ...current, voided: true });
      assertSafeTotals(db);
      return getEntry(db, id);
    });
  });

  app.post(base + '/fees', req => {
    const user = requireFinance(req);
    const input = parse(feeFields, req.body);
    return db.transaction(() => {
      for (const id of input.userIds) assertMember(db, id);
      const id = uid();
      db.run('INSERT INTO fees(id,title,amount,deadline,user_ids,created_at) VALUES(?,?,?,?,?,?)',
        id, input.title, input.amount, input.deadline, JSON.stringify(input.userIds), now());
      db.audit(user.id, 'finance.fee.create', id, input);
      return getFee(db, id);
    });
  });

  app.put(base + '/fees/:id', req => {
    const user = requireFinance(req);
    const id = getId(req);
    const { version, ...input } = parse(updateFee, req.body);
    const request = fingerprint(input);
    return db.transaction(() => {
      const current = getFee(db, id);
      const replay = replayRevision(db, user, 'fee', current, version, request);
      if (replay) return replay;
      for (const memberId of input.userIds) {
        if (!current.userIds.includes(memberId)) assertMember(db, memberId);
      }
      saveRevision(db, user, 'fee', current, 'update', '调整缴费事项', request);
      db.run('UPDATE fees SET title=?,amount=?,deadline=?,user_ids=?,version=version+1 WHERE id=?',
        input.title, input.amount, input.deadline, JSON.stringify(input.userIds), id);
      return getFee(db, id);
    });
  });

  app.post(base + '/payments', req => {
    const user = requireFinance(req);
    const input = parse(createPayment, req.body);
    const request = fingerprint(input);
    return db.transaction(() => {
      const existing = db.get<PaymentRow>(paymentsSql + ' WHERE p.idempotency_key=?', input.idempotencyKey);
      if (existing) return replayCreate(db, 'payment', existing.authorId, user, paymentView(existing), request);
      assertPayer(db, input.feeId, input.userId);
      const id = uid();
      validateAttachments(db, user, input.receiptIds, 'receipt', id);
      db.run(`INSERT INTO payments(id,fee_id,user_id,amount,date,description,receipt_ids,idempotency_key,author_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, id, input.feeId, input.userId, input.amount, input.date, input.description,
        JSON.stringify(input.receiptIds), input.idempotencyKey, user.id, now());
      insertEntry(db, user, uid(), { ...input, type: 'income', category: '班费收入' }, null, id);
      bindAttachments(db, input.receiptIds, id);
      assertSafeTotals(db);
      db.audit(user.id, 'finance.payment.create', id, { request });
      return getPayment(db, id);
    });
  });

  app.put(base + '/payments/:id', req => {
    const user = requireFinance(req);
    const id = getId(req);
    const { version, reason, ...changes } = parse(updatePayment, req.body);
    const request = fingerprint({ action: 'update', reason, changes });
    return db.transaction(() => {
      const current = getPayment(db, id);
      const replay = replayRevision(db, user, 'payment', current, version, request);
      if (replay) return replay;
      assertActive(current);
      const entry = linkedEntry(db, id);
      const next = { ...current, ...changes };
      if (next.feeId !== current.feeId || next.userId !== current.userId) assertPayer(db, next.feeId, next.userId);
      validateAttachments(db, user, next.receiptIds, 'receipt', id);
      saveRevision(db, user, 'payment', current, 'update', reason, request);
      saveRevision(db, user, 'entry', entry, 'update', reason);
      db.run('UPDATE payments SET fee_id=?,user_id=?,amount=?,date=?,description=?,receipt_ids=?,version=version+1 WHERE id=?',
        next.feeId, next.userId, next.amount, next.date, next.description, JSON.stringify(next.receiptIds), id);
      saveEntry(db, { ...entry, amount: next.amount, date: next.date, description: next.description,
        receiptIds: next.receiptIds, publicReceipt: next.publicReceipt });
      bindAttachments(db, next.receiptIds, id);
      assertSafeTotals(db);
      return getPayment(db, id);
    });
  });

  app.post(base + '/payments/:id/void', req => {
    const user = requireFinance(req);
    const id = getId(req);
    const { version, reason } = parse(voidFields, req.body);
    const request = fingerprint({ action: 'void', reason });
    return db.transaction(() => {
      const current = getPayment(db, id);
      const replay = replayRevision(db, user, 'payment', current, version, request);
      if (replay) return replay;
      assertActive(current);
      const entry = linkedEntry(db, id);
      saveRevision(db, user, 'payment', current, 'void', reason, request);
      saveRevision(db, user, 'entry', entry, 'void', reason);
      db.run('UPDATE payments SET voided=1,version=version+1 WHERE id=?', id);
      saveEntry(db, { ...entry, voided: true });
      assertSafeTotals(db);
      return getPayment(db, id);
    });
  });

  app.post(base + '/export', async req => {
    const user = requireFinanceReader(req);
    const finance = readFinance(db, user);
    const names = new Map(db.all<{ id: string; name: string }>('SELECT id,name FROM users').map(row => [row.id, row.name]));
    const feeNames = new Map(finance.fees.map(fee => [fee.id, fee.title]));
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet('余额总览');
    summary.addRows([['期初（分）', '收入（分）', '支出（分）', '余额（分）'],
      [finance.opening, finance.income, finance.expense, finance.balance]]);
    const ledger = wb.addWorksheet('收支台账');
    const labels = { opening: '期初', income: '收入', expense: '支出' };
    ledger.addRow(['日期', '类型', '类别', '说明', '金额（分）', '登记人', '凭证编号', '缴费编号', '版本', '状态']);
    for (const entry of finance.entries) {
      ledger.addRow([entry.date, labels[entry.type], entry.category, entry.description, entry.amount,
        entry.authorName, entry.receiptIds.join('、'), entry.paymentId, entry.version, entry.voided ? '已作废' : '有效']);
    }
    const fees = wb.addWorksheet('缴费事项');
    fees.addRow(['事项', '应缴（分）', '截止日期', '缴费对象', '版本']);
    for (const fee of finance.fees) {
      fees.addRow([fee.title, fee.amount, fee.deadline, fee.userIds.map(id => names.get(id) ?? id).join('、'), fee.version]);
    }
    const payments = wb.addWorksheet('个人缴费登记');
    payments.addRow(['编号', '日期', '事项', '缴费人', '金额（分）', '说明', '凭证编号', '版本', '状态']);
    for (const payment of finance.payments) {
      payments.addRow([payment.id, payment.date, feeNames.get(payment.feeId), payment.name, payment.amount,
        payment.description, payment.receiptIds.join('、'), payment.version, payment.voided ? '已作废' : '有效']);
    }
    for (const sheet of wb.worksheets) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).font = { bold: true };
      for (const column of sheet.columns) column.width = 22;
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return createExport(db, user, '班费台账.xlsx', buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { kind: 'finance' });
  });
}
