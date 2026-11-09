import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultConfig } from './catalog.ts';
import { conflict, HttpError, json, now, parse, requirePermission, requireUser, uid, versionSchema, type User } from './common.ts';
import type { Store } from './db.ts';
import {replaceAvatar} from './files.ts';
import {can, effectivePermissions, isClassMember, validatePermissions, type Permission} from '../shared/permissions.ts';

const sessionCookie = 'class_session';
const sessionSeconds = 7 * 24 * 60 * 60;
const loginWindow = 15 * 60 * 1000;
const role = z.enum(['super_admin', 'admin', 'committee', 'student']);
const username = z.string().trim().min(1).max(64);
const name = z.string().trim().min(1).max(80);
const password = z.string().min(8, '密码至少需要 8 个字符').max(128);
const suppliedPassword = z.string().min(1).max(128);
const newUser = z.object({ username, name, role, password, financeManage: z.boolean().optional(), inClass: z.boolean().optional(), permissions:z.array(z.string()).optional() }).strict();
function checkedPermissions(input:unknown):Permission[] {try{return validatePermissions(input);}catch(error){throw new HttpError(400,(error as Error).message);}}

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
  profile: string;
  permissions: string;
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
    permissions: effectivePermissions({role:row.role,permissions:json<Permission[]>(row.permissions,[]),financeManage:Boolean(row.finance_manage)}),
    financeManage: row.role === 'committee' && Boolean(row.finance_manage),
    inClass: isClassMember({role:row.role,inClass:Boolean(row.in_class)}),
    avatarFileId: json<{avatarFileId?:string}>(row.profile,{}).avatarFileId || null,
    mustChangePassword: Boolean(row.must_change_password),
    active: Boolean(row.active),
    version: row.version,
  };
}

function insertUser(db: Store, input: z.infer<typeof newUser>, passwordHash: string, mustChange: boolean) {
  const id = uid();
  const permissions=checkedPermissions(input.permissions??[]);
  if(input.role!=='admin'&&permissions.length)throw new HttpError(400,'只有管理员可分配操作权限');
  if (db.get('SELECT id FROM users WHERE username=?', input.username)) throw new HttpError(409, '登录账号已存在');
  db.run(`INSERT INTO users (id, username, name, password_hash, role, finance_manage, in_class, must_change_password, created_at, permissions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.username, input.name, passwordHash, input.role,
  Number(input.role === 'committee' && Boolean(input.financeManage)), Number((input.role === 'admin'||input.role==='super_admin') && Boolean(input.inClass)), Number(mustChange), now(),JSON.stringify(permissions));
  return publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', id)!);
}

export function createUser(db: Store, input: z.input<typeof newUser> & { mustChangePassword?: boolean }): User {
  const {mustChangePassword,...fields}=input;
  const validated = parse(newUser, fields);
  const passwordHash = hashPassword(validated.password);
  return db.transaction(() => insertUser(db, validated, passwordHash, input.mustChangePassword ?? true));
}

function currentActor(db:Store,request:FastifyRequest,permission?:Permission):User {
  const original=requireUser(request),row=db.get<UserRow>('SELECT * FROM users WHERE id=?',original.id);
  if(!row||!row.active)throw new HttpError(401,'账号已停用');
  const actor=publicUser(row);
  if(actor.mustChangePassword)throw new HttpError(403,'请先修改初始密码');
  if(permission&&!can(actor,permission))throw new HttpError(403,'没有执行此操作的权限');
  return actor;
}
function requireRoot(actor:User) {if(actor.role!=='super_admin')throw new HttpError(403,'需要 Admin 权限');}
function protectTarget(actor:User,target:Pick<User,'role'>) {
  if(actor.role!=='super_admin'&&(target.role==='admin'||target.role==='super_admin'))throw new HttpError(403,'只有 Admin 可管理管理员账号');
}
function checkSubset(actor:User,target:Parameters<typeof effectivePermissions>[0]) {
  protectTarget(actor,target);
  if(actor.role!=='super_admin'&&effectivePermissions(target).some(p=>!can(actor,p)))throw new HttpError(403,'目标账号的管理权限超过您的授权，请联系 Admin');
}
function authorizeCreate(actor:User,input:z.infer<typeof newUser>) {
  protectTarget(actor,input);
  if(actor.role!=='super_admin'&&(input.financeManage||input.permissions?.length))throw new HttpError(403,'只有 Admin 可分配权限');
  checkSubset(actor,{...input,permissions:checkedPermissions(input.permissions??[])});
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
  });
  // A request body may arrive slowly. Read identity after parsing/validation so
  // access revoked while it was in flight cannot survive as an old snapshot.
  app.addHook('preHandler', async request => {
    if (!request.url.startsWith('/api/')) return;
    request.user = null;
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
    if (input.newPassword === input.currentPassword) throw new HttpError(400, '新密码须与当前密码不同');
    const hash = hashPassword(input.newPassword);
    const token = db.transaction(() => {
      const row = db.get<UserRow>('SELECT * FROM users WHERE id=?', user.id);
      if(!row||!row.active)throw new HttpError(401,'账号已停用');
      if (!verifyPassword(input.currentPassword, row.password_hash)) throw new HttpError(400, '当前密码不正确');
      db.run('UPDATE users SET password_hash=?, must_change_password=0, version=version+1 WHERE id=?', hash, row.id);
      db.run('DELETE FROM sessions WHERE user_id=?', row.id);
      db.audit(row.id, 'user.password', row.id, {});
      return issueSession(db, row.id, request);
    });
    setSession(reply, token);
    return {user: publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', user.id)!)};
  });
  app.put('/api/auth/avatar', async request => {
    requireUser(request);
    const input=parse(z.object({avatarFileId:z.string().min(1).nullable(),version:versionSchema}),request.body);
    return db.transaction(()=>{
      const user=currentActor(db,request);
      const row=db.get<UserRow>('SELECT * FROM users WHERE id=?',user.id)!;
      conflict(row.version,input.version);
      const profile=json<Record<string,unknown>>(row.profile,{});
      const previousId=typeof profile.avatarFileId==='string'&&profile.avatarFileId?profile.avatarFileId:null;
      replaceAvatar(db,user,user.id,previousId,input.avatarFileId);
      db.run('UPDATE users SET profile=?,version=version+1 WHERE id=?',JSON.stringify({...profile,avatarFileId:input.avatarFileId}),user.id);
      const config=db.setting('class',defaultConfig);
      db.setSetting('class',{...config,version:config.version+1});
      db.audit(user.id,'user.avatar',user.id,{before:previousId,after:input.avatarFileId});
      return {user:publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?',user.id)!)};
    });
  });
  app.get('/api/users', async request => {
    const actor=requirePermission(request,'accounts.read');
    return db.all<UserRow>(`SELECT * FROM users ${actor.role==='super_admin'?'':"WHERE role IN ('committee','student')"} ORDER BY username`).map(publicUser);
  });
  app.post('/api/users', async (request, reply) => {
    requirePermission(request,'accounts.create');
    const input = parse(newUser, request.body);
    const hash=hashPassword(input.password);
    const user = db.transaction(() => {
      const admin=currentActor(db,request,'accounts.create');
      authorizeCreate(admin,input);
      const created = insertUser(db, input,hash,true);
      db.audit(admin.id, 'user.create', created.id, {role:created.role,permissions:created.permissions});
      return created;
    });
    return reply.code(201).send(user);
  });
  app.post('/api/users/batch', async (request, reply) => {
    requirePermission(request,'accounts.create');
    const {users} = parse(z.object({users: z.array(newUser).min(1).max(200)}).strict(), request.body);
    const hashes = users.map(user => hashPassword(user.password));
    db.transaction(() => {
      const admin=currentActor(db,request,'accounts.create');
      const names=new Set<string>();
      for(const user of users) {
        authorizeCreate(admin,user);
        if(names.has(user.username)||db.get('SELECT id FROM users WHERE username=?',user.username))throw new HttpError(409,'名单含有重复或已有账号');
        names.add(user.username);
      }
      const created = users.map((user, index) => insertUser(db, user, hashes[index], true));
      db.audit(admin.id, 'user.batch', admin.id, {userIds:created.map(u=>u.id),grants:created.map(u=>({id:u.id,role:u.role,permissions:u.permissions}))});
    });
    return reply.code(201).send({count: users.length});
  });
  app.put<{Params:{id:string}}>('/api/users/:id', async request => {
    requireUser(request);
    const {id} = request.params;
    const input = parse(z.object({username:username.optional(),name, role, active: z.boolean(), financeManage: z.boolean(), inClass: z.boolean().optional(), version: versionSchema}).strict(), request.body);
    return db.transaction(() => {
      const admin=currentActor(db,request,'accounts.read');
      const row = db.get<UserRow>('SELECT * FROM users WHERE id=?', id);
      if (!row) throw new HttpError(404, '账号不存在');
      protectTarget(admin,row);protectTarget(admin,input);
      conflict(row.version, input.version);
      const before=publicUser(row);
      const inClass=(input.role==='admin'||input.role==='super_admin')&&(input.inClass??((row.role==='admin'||row.role==='super_admin')&&Boolean(row.in_class)));
      const financeManage=input.role==='committee'&&input.financeManage;
      const nextUsername=input.username??row.username;
      const nameChanged=input.name!==row.name,roleChanged=input.role!==row.role,statusChanged=input.active!==Boolean(row.active);
      const financeChanged=financeManage!==before.financeManage,usernameChanged=nextUsername!==row.username;
      if(input.username!==undefined)requireRoot(admin);
      if(nameChanged||inClass!==Boolean(row.in_class))if(!can(admin,'accounts.edit'))throw new HttpError(403,'没有编辑账号资料的权限');
      if(roleChanged&&!can(admin,'accounts.roles'))throw new HttpError(403,'没有调整身份的权限');
      if(statusChanged&&!can(admin,'accounts.status'))throw new HttpError(403,'没有启用或停用账号的权限');
      if(financeChanged)requireRoot(admin);
      if(roleChanged||statusChanged) {
        checkSubset(admin,before);
        checkSubset(admin,{role:input.role,financeManage,permissions:roleChanged?[]:before.permissions});
      }
      if(usernameChanged&&db.get('SELECT id FROM users WHERE username=? AND id<>?',nextUsername,id))throw new HttpError(409,'登录账号已存在');
      if (row.active && row.role === 'super_admin' && (!input.active || input.role !== 'super_admin') &&
        !db.get("SELECT id FROM users WHERE role='super_admin' AND active=1 AND id<>?", id)) {
        throw new HttpError(409, '至少保留一名启用的 Admin');
      }
      const permissions=input.role==='admin'&&!roleChanged?row.permissions:'[]';
      db.run(`UPDATE users SET username=?,name=?, role=?, active=?, finance_manage=?, in_class=?,permissions=?, version=version+1 WHERE id=?`,
        nextUsername,input.name, input.role, Number(input.active), Number(financeManage), Number(inClass),permissions, id);
      if (usernameChanged||roleChanged||statusChanged||financeChanged) db.run('DELETE FROM sessions WHERE user_id=?', id);
      if (!input.active || !isClassMember({role:input.role,inClass})) markUnfinishedExcused(db, id);
      const updated = publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?', id)!);
      db.audit(admin.id, 'user.update', id, {before: publicUser(row), after: updated});
      return updated;
    });
  });
  app.post<{Params:{id:string}}>('/api/users/:id/reset-password', async request => {
    requirePermission(request,'accounts.resetPassword');
    const {id} = request.params;
    const input = parse(z.object({password,version:versionSchema}).strict(), request.body);
    const hash = hashPassword(input.password);
    db.transaction(() => {
      const admin=currentActor(db,request,'accounts.resetPassword');
      const target=db.get<UserRow>('SELECT * FROM users WHERE id=?',id);
      if(!target)throw new HttpError(404,'账号不存在');
      checkSubset(admin,publicUser(target));
      conflict(target.version,input.version);
      db.run('UPDATE users SET password_hash=?, must_change_password=1, version=version+1 WHERE id=?', hash, id);
      db.run('DELETE FROM sessions WHERE user_id=?', id);
      db.audit(admin.id, 'user.reset-password', id, {});
    });
    return {ok: true};
  });
  app.put<{Params:{id:string}}>('/api/users/:id/permissions',async request=>{
    requireUser(request);
    const input=parse(z.object({permissions:z.array(z.string()),version:versionSchema}).strict(),request.body);
    const permissions=checkedPermissions(input.permissions);
    return db.transaction(()=>{
      const actor=currentActor(db,request);requireRoot(actor);
      const target=db.get<UserRow>('SELECT * FROM users WHERE id=?',request.params.id);
      if(!target)throw new HttpError(404,'账号不存在');
      if(target.role!=='admin')throw new HttpError(400,'只有管理员可分配操作权限');
      conflict(target.version,input.version);
      db.run('UPDATE users SET permissions=?,version=version+1 WHERE id=?',JSON.stringify(permissions),target.id);
      db.audit(actor.id,'user.permissions',target.id,{before:json(target.permissions,[]),after:permissions});
      return publicUser(db.get<UserRow>('SELECT * FROM users WHERE id=?',target.id)!);
    });
  });
}
