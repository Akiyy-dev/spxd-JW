import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultConfig } from './catalog.ts';
import { conflict, HttpError, now, parse, requireAdmin, uid, versionSchema, type User } from './common.ts';
import type { Store } from './db.ts';

const sessionCookie = 'class_session';
const sessionSeconds = 7 * 24 * 60 * 60;
const loginWindow = 15 * 60 * 1000;
const role = z.enum(['admin', 'committee', 'student']);
const username = z.string().trim().min(1).max(64);
const name = z.string().trim().min(1).max(80);
const password = z.string().min(8, '密码至少需要 8 个字符').max(128);
const suppliedPassword = z.string().min(1).max(128);
const newUser = z.object({ username, name, role, password, financeManage: z.boolean().optional(), inClass: z.boolean().optional() });

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: User['role'];
  password_hash: string;
  finance_manage: number;
  in_class: number;
  must_change_password: number;
  active: number;
  version: number;
}

export function hashPassword(value: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}

export function verifyPassword(value: string, hash: string): boolean {
  const [algorithm, salt, key] = hash.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f\d]{32}$/.test(salt ?? '') || !/^[a-f\d]{128}$/.test(key ?? '')) return false;
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(key, 'hex'));
}

export function publicUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    financeManage: row.role === 'committee' && Boolean(row.finance_manage),
    inClass: row.role !== 'admin' || Boolean(row.in_class),
    mustChangePassword: Boolean(row.must_change_password),
    active: Boolean(row.active),
    version: row.version,
  };
}

function insertUser(db: Store, input: z.infer<typeof newUser>, passwordHash: string, mustChange: boolean) {
  const id = uid();
  if (db.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '登录账号已存在');
  db.run(`INSERT INTO users (id, username, name, password_hash, role, finance_manage, in_class, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.username, input.name, passwordHash, input.role,
  Number(input.role === 'committee' && Boolean(input.financeManage)), Number(input.role === 'admin' && Boolean(input.inClass)), Number(mustChange), now());
  return publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', id)!);
}

export function createUser(db: Store, input: z.input<typeof newUser> & { mustChangePassword?: boolean }): User {
  const validated = parse(newUser, input);
  const passwordHash = hashPassword(validated.password);
  return db.transaction(() => insertUser(db, validated, passwordHash, input.mustChangePassword ?? true));
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = () => ({ path: '/api', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const });

function issueSession(db: Store, id: string, request: FastifyRequest) {
  const oldToken = request.cookies[sessionCookie];
  if (oldToken) db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash(oldToken));
  const token = randomBytes(32).toString('base64url');
  db.run('DELETE FROM sessions WHERE expires_at<=?', now());
  db.run('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash(token), id, new Date(Date.now() + sessionSeconds * 1000).toISOString());
  return token;
}

function setSession(reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie, token, {...cookieOptions(), maxAge: sessionSeconds});
}

export function registerRequestAuth(app: FastifyInstance, db: Store) {
  const origins = new Set([process.env.APP_ORIGIN]);
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  app.decorateRequest('user', null);
  app.addHook('onRequest', async request => {
    if (!request.url.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const {origin, 'sec-fetch-site': fetchSite} = request.headers;
      if (origin ? !origins.has(origin) : fetchSite === 'cross-site' || fetchSite === 'same-site') {
        throw new HttpError(403, '请求来源不受信任');
      }
    }
    const token = request.cookies[sessionCookie];
    if (!token || !/^[\w-]{43}$/.test(token)) return;
    const row = db.get<UserRow>(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, tokenHash(token), now());
    if (row) request.user = publicUser(row);
  });
}

function markUnfinishedExcused(db: Store, userId: string) {
  const unfinished = `SELECT p.task_id FROM participants p WHERE p.user_id=? AND p.status='required'
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.task_id=p.task_id AND s.user_id=p.user_id)`;
  db.run(`UPDATE tasks SET version=version+1, updated_at=? WHERE id IN (${unfinished})`, now(), userId);
  db.run(`UPDATE participants SET status='excused' WHERE user_id=? AND task_id IN (${unfinished})`, userId, userId);
}

export function registerAuth(app: FastifyInstance, db: Store) {
  const fakeHash = hashPassword(randomBytes(32).toString('hex'));
  const attempts = new Map<string, number>();
  let clearAttemptsAt = Date.now() + loginWindow;

  app.get('/api/auth/me', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {user: request.user};
  });
  app.get('/api/public/config', async () => {
    const config = db.setting<typeof defaultConfig & {photoFileId?:string}>('class', defaultConfig);
    const {name, subtitle, introduction, academicYear, semesterStart, semesterEnd, holidays, demo, photoFileId} = config;
    return {name, subtitle, introduction, academicYear, semesterStart, semesterEnd, holidays, demo, photoFileId};
  });
  app.post('/api/auth/login', async (request, reply) => {
    const input = parse(z.object({username, password: suppliedPassword}), request.body);
    if (Date.now() >= clearAttemptsAt) {
      attempts.clear();
      clearAttemptsAt = Date.now() + loginWindow;
    }
    const ipKey = `ip:${request.ip}`;
    const userKey = `${ipKey}:${input.username}`;
    const ipCount = attempts.get(ipKey) ?? 0;
    const userCount = attempts.get(userKey) ?? 0;
    if (ipCount >= 30 || userCount >= 5) {
      reply.header('Retry-After', String(Math.ceil((clearAttemptsAt - Date.now()) / 1000)));
      throw new HttpError(429, '登录尝试过多，请稍后再试');
    }
    const row = db.get<UserRow>('SELECT * FROM users WHERE username=?', input.username);
    const valid = verifyPassword(input.password, row?.password_hash ?? fakeHash);
    if (!row || !row.active || !valid) {
      attempts.set(ipKey, ipCount + 1);
      attempts.set(userKey, userCount + 1);
      throw new HttpError(401, '账号或密码不正确');
    }
    attempts.delete(userKey);
    setSession(reply, db.transaction(() => issueSession(db, row.id, request)));
    return {user: publicUser(row)};
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) db.run('DELETE FROM sessions WHERE token_hash=?', tokenHash(token));
    reply.clearCookie(sessionCookie, cookieOptions());
    return {ok: true};
  });
  app.post('/api/auth/password', async (request, reply) => {
    const user = request.user;
    if (!user) throw new HttpError(401, '请先登录');
    const input = parse(z.object({currentPassword: suppliedPassword, newPassword: password}), request.body);
    const row = db.get<UserRow>('SELECT * FROM users WHERE id=?', user.id)!;
    if (!verifyPassword(input.currentPassword, row.password_hash)) throw new HttpError(400, '当前密码不正确');
    if (input.newPassword === input.currentPassword) throw new HttpError(400, '新密码须与当前密码不同');
    const hash = hashPassword(input.newPassword);
    const token = db.transaction(() => {
      db.run('UPDATE users SET password_hash=?, must_change_password=0, version=version+1 WHERE id=?', hash, row.id);
      db.run('DELETE FROM sessions WHERE user_id=?', row.id);
      db.audit(row.id, 'user.password', row.id, {});
      return issueSession(db, row.id, request);
    });
    setSession(reply, token);
    return {user: publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', row.id)!)};
  });
  app.get('/api/users', async request => {
    requireAdmin(request);
    return db.all<UserRow>('SELECT * FROM users ORDER BY username').map(publicUser);
  });
  app.post('/api/users', async (request, reply) => {
    const admin = requireAdmin(request);
    const input = parse(newUser, request.body);
    const user = db.transaction(() => {
      const created = createUser(db, input);
      db.audit(admin.id, 'user.create', created.id, {role:created.role});
      return created;
    });
    return reply.code(201).send(user);
  });
  app.post('/api/users/batch', async (request, reply) => {
    const admin = requireAdmin(request);
    const {users} = parse(z.object({users: z.array(newUser.omit({financeManage:true})).min(1).max(200)}), request.body);
    const names = new Set<string>();
    for (const user of users) {
      if (names.has(user.username) || db.get('SELECT id FROM users WHERE username=?', user.username)) {
        throw new HttpError(409, '名单含有重复或已有账号');
      }
      names.add(user.username);
    }
    const hashes = users.map(user => hashPassword(user.password));
    db.transaction(() => {
      const userIds = users.map((user, index) => insertUser(db, user, hashes[index], true).id);
      db.audit(admin.id, 'user.batch', admin.id, {userIds});
    });
    return reply.code(201).send({count: users.length});
  });
  app.put<{Params:{id:string}}>('/api/users/:id', async request => {
    const admin = requireAdmin(request);
    const {id} = request.params;
    const input = parse(z.object({name, role, active: z.boolean(), financeManage: z.boolean(), inClass: z.boolean().optional(), version: versionSchema}), request.body);
    return db.transaction(() => {
      const row = db.get<UserRow>('SELECT * FROM users WHERE id=?', id);
      if (!row) throw new HttpError(404, '账号不存在');
      conflict(row.version, input.version);
      if (row.active && row.role === 'admin' && (!input.active || input.role !== 'admin') &&
        !db.get("SELECT id FROM users WHERE role='admin' AND active=1 AND id<>?", id)) {
        throw new HttpError(409, '至少保留一名有效管理员');
      }
      const inClass = input.role === 'admin' && (input.inClass ?? (row.role === 'admin' && Boolean(row.in_class)));
      db.run(`UPDATE users SET name=?, role=?, active=?, finance_manage=?, in_class=?, version=version+1 WHERE id=?`,
        input.name, input.role, Number(input.active), Number(input.role === 'committee' && input.financeManage), Number(inClass), id);
      if (!input.active) db.run('DELETE FROM sessions WHERE user_id=?', id);
      if (!input.active || (input.role === 'admin' && !inClass)) markUnfinishedExcused(db, id);
      const updated = publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', id)!);
      db.audit(admin.id, 'user.update', id, {before: publicUser(row), after: updated});
      return updated;
    });
  });
  app.post<{Params:{id:string}}>('/api/users/:id/reset-password', async request => {
    const admin = requireAdmin(request);
    const {id} = request.params;
    const input = parse(z.object({password}), request.body);
    if (!db.get('SELECT id FROM users WHERE id=?', id)) throw new HttpError(404, '账号不存在');
    const hash = hashPassword(input.password);
    db.transaction(() => {
      db.run('UPDATE users SET password_hash=?, must_change_password=1, version=version+1 WHERE id=?', hash, id);
      db.run('DELETE FROM sessions WHERE user_id=?', id);
      db.audit(admin.id, 'user.reset-password', id, {});
    });
    return {ok: true};
  });
}
