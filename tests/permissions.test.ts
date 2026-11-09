import assert from 'node:assert/strict';
import test from 'node:test';

test('explicit administrator grants fail closed and never imply unrelated operations', async () => {
  const {can, addPermission, effectivePermissions} = await import('../shared/permissions.ts');
  assert.equal(can({role:'admin'}, 'finance.read'), false);
  assert.equal(can({role:'admin',permissions:[]}, 'homework.create'), false);
  const permissions = addPermission([], 'finance.entries.create');
  assert.equal(can({role:'admin',permissions}, 'finance.read'), true);
  assert.equal(can({role:'admin',permissions}, 'finance.entries.create'), true);
  assert.equal(can({role:'admin',permissions}, 'finance.export'), false);
  assert.equal(can({role:'admin',permissions:['finance.entries.create']}, 'finance.entries.create'), false);
  assert.equal(can({role:'committee'}, 'homework.publish'), true);
  assert.equal(can({role:'committee'}, 'accounts.read'), false);
  assert.equal(can({role:'committee'}, 'finance.read'), false);
  assert.equal(can({role:'committee',financeManage:true}, 'finance.read'), true);
  assert.equal(can({role:'student',permissions:['finance.read']}, 'finance.read'), false);
  assert.ok(effectivePermissions({role:'super_admin'}).length > 40);
});

test('permission input rejects missing dependencies, unknowns and duplicates, and editors cascade', async () => {
  const {validatePermissions, addPermission, removePermission, can, isClassMember} = await import('../shared/permissions.ts');
  assert.throws(()=>validatePermissions(['unknown']));
  assert.throws(()=>validatePermissions(['finance.read','finance.read']));
  assert.throws(()=>validatePermissions(['homework.export']));
  const list=addPermission([], 'homework.export');
  assert.deepEqual(new Set(list), new Set(['homework.export','homework.submissions.read','homework.participants.read']));
  assert.deepEqual(validatePermissions(list),list);
  assert.equal(can({role:'admin',permissions:removePermission(list,'homework.participants.read')},'homework.export'),false);
  assert.equal(isClassMember({role:'super_admin'}),false);
  assert.equal(isClassMember({role:'super_admin',inClass:true}),true);
  assert.equal(isClassMember({role:'student'}),true);
});
