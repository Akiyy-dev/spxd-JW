import assert from 'node:assert/strict';
import test from 'node:test';
import {authPath, loginReturnTo} from '../src/auth-redirect.ts';

const target = '/homework/a73506d7-04fd-4293-b2c6-7a6e7578ab19?source=wechat&text=%E4%BD%9C%E4%B8%9A#details';

test('login URL preserves the complete shared destination without browser history state', () => {
  const login = authPath('/login', target);
  assert.equal(new URL(login, 'https://class.test').pathname, '/login');
  assert.equal(loginReturnTo(new URL(login, 'https://class.test').search), target);
});

test('forced password change carries the same destination through another page load', () => {
  const account = authPath('/account', target);
  assert.equal(new URL(account, 'https://class.test').pathname, '/account');
  assert.equal(loginReturnTo(new URL(account, 'https://class.test').search), target);
});

test('ordinary login defaults home and existing history-state links remain supported', () => {
  assert.equal(loginReturnTo(''), '/');
  assert.equal(authPath('/login', '/'), '/login');
  assert.equal(authPath('/account', '/'), '/account?returnTo=%2F');
  assert.equal(loginReturnTo('', {from: target}), target);
  assert.equal(loginReturnTo('?returnTo=%2Fduties', {from: target}), '/duties');
  assert.equal(loginReturnTo('', {from: 42}), '/');
  assert.equal(loginReturnTo('', null), '/');
});

test('default home remains explicit during forced password change if the session expires again', () => {
  const account = new URL(authPath('/account', '/'), 'https://class.test');
  assert.equal(account.searchParams.has('returnTo'), true);
  const login = new URL(authPath('/login', loginReturnTo(account.search)), 'https://class.test');
  assert.equal(loginReturnTo(login.search), '/');
});

test('return targets cannot leave the site or loop through login', () => {
  for (const target of [
    '', 'https://evil.test/', '//evil.test/', '/\\evil.test/', '/\n/evil.test/',
    'javascript:alert(1)', 'homework/id', '/login', '/LOGIN/?returnTo=%2Fhomework%2Fid',
    '/x/../login', '/%6cogin', '/%2flogin', '/%5cevil.test', '/%0alogin',
  ]) {
    const search = '?' + new URLSearchParams({returnTo: target});
    assert.equal(loginReturnTo(search), '/', target);
    assert.equal(loginReturnTo('', {from: target}), '/', target);
    assert.equal(authPath('/login', target), '/login', target);
  }
});

test('same-site destinations keep encoded values and support returning to personal account', () => {
  for (const target of ['/account', '/affairs/id?value=a%2Bb%26c#form', '/homework/id?url=https%3A%2F%2Fexample.test']) {
    assert.equal(loginReturnTo('?' + new URLSearchParams({returnTo: target})), target);
  }
  assert.equal(loginReturnTo('?returnTo=%2Flogin', {from:'/duties'}), '/');
});
