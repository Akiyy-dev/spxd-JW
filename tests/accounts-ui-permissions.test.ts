import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Children, createElement, isValidElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { User } from '../src/types.ts';
import { PERMISSION_KEYS, type Permission } from '../shared/permissions.ts';

registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: 'export default ""', shortCircuit: true } : next(url, context); } });
const { Accounts, AccountEditor, ResetPassword, PermissionEditor, PermissionOptions } = await import('../src/accounts.tsx');
const noop = () => {};
const user = (permissions: Permission[] = [], extra: Partial<User> = {}): User => ({ id: 'actor', username: 'actor-login', name: '姓名', role: 'admin', permissions, inClass: false, financeManage: false, active: true, mustChangePassword: false, version: 1, ...extra });
const student = user([], { id: 'student', username: 'student-login', role: 'student', inClass: true });
const root = user([], { role: 'super_admin' });
const editor = (actor: User, target?: User) => renderToStaticMarkup(createElement(AccountEditor, { actor, user: target, close: noop, saved: noop }));
function input(markup: string, name: string) {
  const result = [...markup.matchAll(/<input\b[^>]*>/g)].find(match => match[0].includes(`name="${name}"`))?.[0];
  assert.ok(result, `input ${name} exists`);
  return result;
}
function elements(node: ReactNode): { type: unknown; props: Record<string, unknown> }[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [{ type: child.type, props: child.props }, ...elements(child.props.children)];
  });
}

test('account creation controls require create permission and filter higher-capability roles', () => {
  const denied = renderToStaticMarkup(createElement(Accounts, { user: user(['accounts.read']), changed: noop }));
  assert.doesNotMatch(denied, /创建账号|批量创建/);
  const allowed = renderToStaticMarkup(createElement(Accounts, { user: user(['accounts.read', 'accounts.create']), changed: noop }));
  assert.match(allowed, /创建账号/);
  assert.match(allowed, /批量创建/);
  const creator = editor(user(['accounts.read', 'accounts.create']));
  assert.match(creator, /<option value="student" selected="">学生<\/option>/);
  assert.doesNotMatch(creator, /value="admin"|value="super_admin"|value="committee"/);
  assert.match(input(creator, 'password'), /type="password"/);
  const elevated = editor(root);
  assert.match(elevated, /value="admin"/);
  assert.match(elevated, /value="super_admin"/);
});

test('ordinary name editors cannot change username, role, active status or committee finance authorization', () => {
  const target = user([], { id: 'committee', username: 'committee-login', role: 'committee', financeManage: true, inClass: true, active: false });
  const markup = editor(user(['accounts.read', 'accounts.edit']), target);
  assert.match(input(markup, 'username'), /readonly=""/i);
  assert.match(input(markup, 'username'), /value="committee-login"/);
  assert.doesNotMatch(input(markup, 'name'), /readonly|disabled/i);
  assert.match(markup, /<select disabled="">/);
  assert.match(input(markup, 'active'), /disabled=""/);
  assert.doesNotMatch(input(markup, 'active'), /checked=""/);
  assert.doesNotMatch(markup, /name="financeManage"|name="password"/);
});

test('status-only editors can update enabled status while name and role controls preserve existing values', () => {
  const markup = editor(user(['accounts.read', 'accounts.status']), student);
  assert.match(input(markup, 'name'), /readonly=""/i);
  assert.match(input(markup, 'name'), /value="姓名"/);
  assert.match(markup, /<select disabled="">/);
  assert.match(input(markup, 'active'), /checked=""/);
  assert.doesNotMatch(input(markup, 'active'), /disabled/);
});

test('Admin can rename accounts and preserve explicit roster and committee finance choices', () => {
  const elevated = editor(root, user([], { inClass: true }));
  assert.doesNotMatch(input(elevated, 'username'), /readonly|disabled/i);
  assert.match(elevated, /修改后该账号的所有登录会话将失效/);
  assert.match(input(elevated, 'inClass'), /checked=""/);
  assert.doesNotMatch(input(elevated, 'inClass'), /disabled/);
  const cashier = editor(root, user([], { role: 'committee', financeManage: true, inClass: true }));
  assert.match(input(cashier, 'financeManage'), /checked=""/);
  assert.doesNotMatch(cashier, /name="password"/);
});

test('ordinary full-grant administrators cannot offer role changes that remove committee finance authorization', () => {
  const cashier = user([], { role: 'committee', financeManage: true, inClass: true });
  const ordinary = editor(user([...PERMISSION_KEYS]), cashier);
  assert.match(ordinary, /<select disabled="">/);
  assert.match(ordinary, /Admin.*财务授权/);
  const elevated = editor(root, cashier);
  assert.doesNotMatch(elevated, /<select disabled="">/);
});

test('password reset renders an empty masked new-password input with an explicit visibility control', () => {
  const markup = renderToStaticMarkup(createElement(ResetPassword, { user: student, close: noop, saved: noop }));
  assert.match(markup, /新临时密码/);
  assert.match(markup, /显示本次输入的密码/);
  assert.match(markup, /原密码无法查看/);
  const password = input(markup, 'password');
  assert.match(password, /type="password"/);
  assert.match(password, /autoComplete="new-password"/);
  assert.match(password, /minLength="8"/);
  assert.doesNotMatch(password, /value=/);
});

test('permission checkbox interactions include prerequisites and cascade removals without altering other modules', () => {
  let selected: Permission[] = ['class.settings.edit'];
  const setSelected = (update: SetStateAction<Permission[]>) => { selected = typeof update === 'function' ? update(selected) : update; };
  function toggle(permission: Permission, checked: boolean) {
    const checkbox = elements(PermissionOptions({ selected, setSelected })).find(element => element.type === 'input' && element.props.name === permission);
    assert.ok(checkbox, permission);
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked } });
  }
  toggle('finance.export', true);
  assert.deepEqual(new Set(selected), new Set(['class.settings.edit', 'finance.read', 'finance.export']));
  let markup = renderToStaticMarkup(createElement(PermissionOptions, { selected, setSelected }));
  assert.match(input(markup, 'finance.read'), /checked=""/);
  assert.match(input(markup, 'finance.export'), /checked=""/);
  assert.doesNotMatch(input(markup, 'finance.entries.create'), /checked=""/);
  toggle('homework.export', true);
  assert.ok(selected.includes('homework.participants.read'));
  assert.ok(selected.includes('homework.submissions.read'));
  toggle('finance.read', false);
  assert.ok(!selected.includes('finance.export'));
  assert.ok(selected.includes('homework.export'));
  assert.ok(selected.includes('class.settings.edit'));
  toggle('homework.submissions.read', false);
  assert.ok(!selected.includes('homework.export'));
  assert.ok(selected.includes('homework.participants.read'));
  markup = renderToStaticMarkup(createElement(PermissionOptions, { selected, setSelected }));
  assert.doesNotMatch(input(markup, 'finance.export'), /checked=""/);
  assert.doesNotMatch(input(markup, 'homework.export'), /checked=""/);
});

test('permission editor starts from the selected administrator grants instead of role-wide defaults', () => {
  const markup = renderToStaticMarkup(createElement(PermissionEditor, { user: user(['finance.read', 'finance.history']), close: noop, saved: noop }));
  assert.match(input(markup, 'finance.read'), /checked=""/);
  assert.match(input(markup, 'finance.history'), /checked=""/);
  assert.doesNotMatch(input(markup, 'finance.export'), /checked=""/);
  assert.doesNotMatch(input(markup, 'accounts.create'), /checked=""/);
  assert.match(markup, /已选择 2 \/ /);
  assert.equal([...markup.matchAll(/type="checkbox"/g)].length, PERMISSION_KEYS.length);
});

test('permission group actions include read dependencies and leave other module grants intact', () => {
  let selected: Permission[] = ['class.settings.edit'];
  const setSelected = (update: SetStateAction<Permission[]>) => { selected = typeof update === 'function' ? update(selected) : update; };
  function groupAction(label: string) {
    const button = elements(PermissionOptions({ selected, setSelected })).find(element => element.type === 'button' && element.props['aria-label'] === label);
    assert.ok(button, label);
    (button.props.onClick as () => void)();
  }
  groupAction('全选班费权限');
  assert.deepEqual(new Set(selected), new Set(['class.settings.edit', 'finance.read', 'finance.history',
    'finance.entries.create', 'finance.entries.edit', 'finance.entries.void', 'finance.fees.create', 'finance.fees.edit',
    'finance.payments.create', 'finance.payments.edit', 'finance.payments.void', 'finance.export']));
  const markup = renderToStaticMarkup(createElement(PermissionOptions, { selected, setSelected }));
  assert.match(markup, /需：查看完整明细/);
  assert.match(markup, /需：查看全班提交、查看参与名单/);
  groupAction('清空班费权限');
  assert.deepEqual(selected, ['class.settings.edit']);
});
