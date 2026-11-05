import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';

const password = 'Initial-Pass2026!';
async function login(app: FastifyInstance, username: string, pass = password) {
  return app.inject({method:'POST', url:'/api/auth/login', payload:{username,password:pass}});
}

test('initial passwords restrict access and changing a password revokes existing sessions', async t => {
  const { buildApp } = await import('../server/app.ts');
  const { createUser } = await import('../server/auth.ts');
  const { createStore } = await import('../server/db.ts');
  const db = createStore();
  const app = await buildApp({db});
  t.after(async () => { await app.close(); db.close(); });
  createUser(db, {username:'001', name:'同学', role:'student', password});
  const response = await login(app, '001');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.mustChangePassword, true);
  assert.match(String(response.headers['set-cookie']), /HttpOnly/i);
  const cookie = response.cookies[0];
  const cookies = {[cookie.name]:cookie.value};
  assert.equal((await app.inject({url:'/api/homework',cookies})).statusCode, 403);
  const change = await app.inject({method:'POST',url:'/api/auth/password',cookies,
    payload:{currentPassword:password,newPassword:'My-New-Pass2026!'}});
  assert.equal(change.statusCode, 200);
  assert.equal(change.json().user.mustChangePassword, false);
  assert.deepEqual((await app.inject({url:'/api/auth/me',cookies})).json(), {user:null});
  const newCookie = change.cookies[0];
  assert.equal((await app.inject({url:'/api/homework',cookies:{[newCookie.name]:newCookie.value}})).statusCode, 200);
});

test('cross-origin login, last-admin demotion and a partial roster import are rejected', async t => {
  const { buildApp } = await import('../server/app.ts');
  const { createUser } = await import('../server/auth.ts');
  const { createStore } = await import('../server/db.ts');
  const db = createStore();
  const app = await buildApp({db});
  t.after(async () => { await app.close(); db.close(); });
  const admin = createUser(db, {username:'admin',name:'管理员',role:'admin',password,mustChangePassword:false});
  assert.equal((await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'https://untrusted.test'},
    payload:{username:'admin',password}})).statusCode, 403);
  const {cookies:[cookie]} = await login(app, 'admin');
  const cookies = {[cookie.name]:cookie.value};
  assert.equal((await app.inject({method:'PUT',url:`/api/users/${admin.id}`,cookies,
    payload:{name:admin.name,role:'committee',active:true,financeManage:false,version:admin.version}})).statusCode, 409);
  const batch = await app.inject({method:'POST',url:'/api/users/batch',cookies,
    payload:{users:[{username:'new',name:'新同学',role:'student',password},
      {username:'admin',name:'重复',role:'student',password}]}});
  assert.equal(batch.statusCode, 409);
  assert.deepEqual((await app.inject({url:'/api/users',cookies})).json(), [admin]);
});

test('repeated invalid credentials are rate limited without disclosing whether a user exists', async t => {
  const { buildApp } = await import('../server/app.ts');
  const app = await buildApp();
  t.after(() => app.close());
  for (let i = 0; i < 5; i++) {
    const result = await login(app, 'missing');
    assert.equal(result.statusCode, 401);
  }
  assert.equal((await login(app, 'missing')).statusCode, 429);
});

test('trusted reverse proxy clients have separate IP-wide login limits', async t => {
  const { buildApp } = await import('../server/app.ts');
  const { createUser } = await import('../server/auth.ts');
  const { createStore } = await import('../server/db.ts');
  const before = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = ' 192.0.2.1 , ::1 ';
  t.after(() => {
    if (before === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = before;
  });
  const db = createStore();
  const app = await buildApp({db});
  t.after(async () => { await app.close(); db.close(); });
  createUser(db, {username:'valid',name:'学生',role:'student',password});
  const attempt = (client: string, username: string) => app.inject({
    method:'POST',url:'/api/auth/login',remoteAddress:'192.0.2.1',
    headers:{'x-forwarded-for':client},payload:{username,password},
  });
  for (let i = 0; i < 30; i++) {
    assert.equal((await attempt('198.51.100.10', `invalid-${i}`)).statusCode, 401);
  }
  assert.equal((await attempt('198.51.100.10', 'valid')).statusCode, 429);
  assert.equal((await attempt('198.51.100.11', 'valid')).statusCode, 200);
});

test('an untrusted caller cannot evade login limits by changing forwarded addresses', async t => {
  const { buildApp } = await import('../server/app.ts');
  const before = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '127.0.0.1,::1';
  t.after(() => {
    if (before === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = before;
  });
  const app = await buildApp();
  t.after(() => app.close());
  for (let i = 0; i <= 5; i++) {
    const result = await app.inject({
      method:'POST',url:'/api/auth/login',remoteAddress:'198.51.100.10',
      headers:{'x-forwarded-for':`203.0.113.${i + 1}`},payload:{username:'missing',password},
    });
    assert.equal(result.statusCode, i < 5 ? 401 : 429);
  }
});
