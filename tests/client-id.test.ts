import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createId } from '../src/id.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('creates UUID v4 identifiers using native Web Crypto', () => {
  const ids = Array.from({ length: 100 }, () => createId());
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});

test('creates distinct UUID v4 identifiers when randomUUID is unavailable', t => {
  const crypto = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  });

  const ids = Array.from({ length: 1000 }, () => createId());
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});
