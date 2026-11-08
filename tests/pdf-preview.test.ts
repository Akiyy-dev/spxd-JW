import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfPageLayout } from '../src/pdf-preview-layout.ts';

test('PDF pages fit their container and render sharply on high-density screens', () => {
  const page = pdfPageLayout(300, 200, 600, 2);
  assert.equal(page.scale, 2);
  assert.equal(page.width, 600);
  assert.equal(page.height, 400);
  assert.equal(page.pixelWidth, 1200);
  assert.equal(page.pixelHeight, 800);
});

test('PDF rendering bounds canvas allocation for very tall pages and high pixel ratios', () => {
  for (const [width, height] of [[100, 100000], [100000, 100], [10000, 10000]]) {
    const page = pdfPageLayout(width, height, 4000, 8);
    assert.ok(page.width <= 4000);
    assert.ok(page.pixelWidth <= 8192 && page.pixelHeight <= 8192);
    assert.ok(page.pixelWidth * page.pixelHeight <= 4 * 1024 * 1024);
    assert.ok(page.pixelWidth > 0 && page.pixelHeight > 0);
    assert.ok(Math.abs(page.width / page.height - width / height) < 0.0001);
  }
});

test('invalid PDF page dimensions fail instead of allocating a corrupt canvas', () => {
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => pdfPageLayout(size, 200, 600));
    assert.throws(() => pdfPageLayout(300, size, 600));
  }
});
