import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImages } from '../src/ws-api.js';

test('keeps the four supported media types', () => {
  const input = [
    { mediaType: 'image/png', data: 'a' },
    { mediaType: 'image/jpeg', data: 'b' },
    { mediaType: 'image/gif', data: 'c' },
    { mediaType: 'image/webp', data: 'd' },
  ];
  assert.deepEqual(sanitizeImages(input), input);
});

test('drops unsupported media types', () => {
  assert.deepEqual(sanitizeImages([{ mediaType: 'image/svg+xml', data: 'a' }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: 'application/pdf', data: 'a' }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: 'text/html', data: 'a' }]), []);
});

test('drops entries without string data', () => {
  assert.deepEqual(sanitizeImages([{ mediaType: 'image/png', data: 123 }]), []);
  assert.deepEqual(sanitizeImages([{ mediaType: 'image/png' }]), []);
  assert.deepEqual(sanitizeImages([null, undefined, 'nope']), []);
});

test('caps at six images', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ mediaType: 'image/png', data: String(i) }));
  const out = sanitizeImages(many);
  assert.equal(out.length, 6);
  assert.deepEqual(out.map((i) => i.data), ['0', '1', '2', '3', '4', '5']);
});

test('drops everything but mediaType and data', () => {
  const out = sanitizeImages([{ mediaType: 'image/png', data: 'a', name: 'x.png', url: 'data:...' }]);
  assert.deepEqual(out, [{ mediaType: 'image/png', data: 'a' }]);
});

test('returns an empty array for anything that is not an array', () => {
  assert.deepEqual(sanitizeImages(undefined), []);
  assert.deepEqual(sanitizeImages(null), []);
  assert.deepEqual(sanitizeImages('nope'), []);
  assert.deepEqual(sanitizeImages({ 0: { mediaType: 'image/png', data: 'a' } }), []);
});
