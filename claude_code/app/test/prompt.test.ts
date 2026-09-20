import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemAppend } from '../src/prompt.js';

const ALL = [
  { path: '/homeassistant', label: 'Home Assistant config' },
  { path: '/config', label: 'Add-on files' },
  { path: '/share', label: 'Share' },
];

test('describes each root that is present', () => {
  const text = buildSystemAppend({ exposeHaApi: true, roots: ALL });
  assert.match(text, /\/homeassistant is the live Home Assistant configuration directory/);
  assert.match(text, /\/config is this add-on's own folder/);
  assert.match(text, /\/share is the folder shared between add-ons/);
});

test('omits roots that are absent', () => {
  const text = buildSystemAppend({ exposeHaApi: true, roots: [ALL[0]] });
  assert.doesNotMatch(text, /add-on's own folder/);
  assert.doesNotMatch(text, /shared between add-ons/);
});

test('documents ha-api when the API is exposed', () => {
  const text = buildSystemAppend({ exposeHaApi: true, roots: ALL });
  assert.match(text, /ha-api METHOD PATH/);
  assert.match(text, /validate with `ha-api POST \/core\/check`/);
});

test('explains the limitation when the API is not exposed', () => {
  const text = buildSystemAppend({ exposeHaApi: false, roots: ALL });
  assert.doesNotMatch(text, /ha-api METHOD PATH/);
  assert.match(text, /turned off API access/);
  assert.match(text, /ask the user to run a configuration check/);
});

test('always states the secrets and .storage rules', () => {
  for (const exposeHaApi of [true, false]) {
    const text = buildSystemAppend({ exposeHaApi, roots: ALL });
    assert.match(text, /Never print the contents of secrets\.yaml/);
    assert.match(text, /Files under \.storage belong to Home Assistant/);
  }
});
