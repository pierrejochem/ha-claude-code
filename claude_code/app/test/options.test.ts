import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIsInsideRoots } from '../src/options.js';

const inside = makeIsInsideRoots([
  { path: '/homeassistant', label: 'Home Assistant config' },
  { path: '/share', label: 'Share' },
]);

test('accepts a root itself', () => {
  assert.equal(inside('/homeassistant'), true);
  assert.equal(inside('/share'), true);
});

test('accepts paths under a root', () => {
  assert.equal(inside('/homeassistant/custom_components'), true);
  assert.equal(inside('/homeassistant/packages/lights.yaml'), true);
});

test('rejects a sibling that merely shares the prefix', () => {
  assert.equal(inside('/homeassistant-backup'), false, 'prefix match must not be a substring match');
  assert.equal(inside('/homeassistantevil/x'), false);
});

test('rejects paths outside every root', () => {
  assert.equal(inside('/etc/passwd'), false);
  assert.equal(inside('/'), false);
  assert.equal(inside('/data/options.json'), false);
});

test('resolves before comparing, so traversal cannot escape', () => {
  assert.equal(inside('/homeassistant/../etc'), false);
  assert.equal(inside('/homeassistant/./www'), true);
});

test('rejects a relative path, which resolves against the process cwd', () => {
  // path.resolve() turns this into <cwd>/../etc/passwd, which is outside every
  // root. The production path resolves twice — once in the /api/dirs handler and
  // once inside isInsideRoots — and this pins that either one alone is enough.
  assert.equal(inside('../etc/passwd'), false);
  assert.equal(inside('etc/passwd'), false);
});

test('rejects empty input', () => {
  assert.equal(inside(''), false);
  assert.equal(inside(null), false);
  assert.equal(inside(undefined), false);
});
