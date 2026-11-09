import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFilePreview, isPreviewableMime } from '../src/file-preview.ts';

test('only supported PDF and raster images expose a preview action', () => {
  for (const mime of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.equal(isPreviewableMime(mime), true, mime);
  }
  for (const mime of ['image/svg+xml', 'text/html', 'application/zip',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    assert.equal(isPreviewableMime(mime), false, mime);
  }
});

test('GIF previews preserve the original animation bytes', async t => {
  const bytes = Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,255,0,0,0,0,0,33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,33,249,4,0,10,0,0,0,44,0,0,0,0,1,0,1,0,128,0,255,0,0,0,0,2,2,68,1,0,59]);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, {headers:{'Content-Type':'image/gif'}}));
  const preview = await createFilePreview('animated-avatar');
  try {
    assert.equal(preview.mime, 'image/gif');
    assert.deepEqual(new Uint8Array(await preview.blob.arrayBuffer()), bytes);
  } finally {preview.dispose();}
});

test('loads authenticated preview bytes into a disposable Blob despite attachment disposition', async t => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).startsWith('blob:')) return realFetch(input, options);
    assert.equal(input, '/api/files/file%20id/preview');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.signal, controller.signal);
    return new Response('%PDF-1.7', {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename=note.pdf' },
    });
  });
  const preview = await createFilePreview('file id', controller.signal);
  assert.equal(await preview.blob.text(), '%PDF-1.7');
  assert.equal(preview.mime, 'application/pdf');
  assert.match(preview.url, /^blob:/);
  assert.equal(await (await fetch(preview.url)).text(), '%PDF-1.7');
  preview.dispose();
  await assert.rejects(fetch(preview.url));
});

test('refuses HTML returned instead of preview bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<h1>Login</h1>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(createFilePreview('file'), /预览/);
});

test('propagates permission failures and signals an expired session', async t => {
  const events = new EventTarget();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  let expired = false;
  events.addEventListener('class-session-expired', () => { expired = true; });
  let status = 403;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: '无权预览此文件' }, { status }));
  await assert.rejects(createFilePreview('file'), /无权预览此文件/);
  assert.equal(expired, false);
  status = 401;
  await assert.rejects(createFilePreview('file'), /无权预览此文件/);
  assert.equal(expired, true);
});

test('an aborted preview load cannot create a usable URL after content arrives', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } });
  });
  await assert.rejects(createFilePreview('file', controller.signal), { name: 'AbortError' });
});
