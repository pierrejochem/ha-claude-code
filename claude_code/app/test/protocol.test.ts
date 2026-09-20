import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, isPermissionMode } from '../src/shared/protocol.js';
import type { SessionEvent } from '../src/shared/protocol.js';

test('MODES matches the add-on options schema', () => {
  assert.deepEqual([...MODES], ['default', 'acceptEdits', 'plan', 'auto']);
});

test('isPermissionMode accepts every mode and rejects others', () => {
  for (const m of MODES) assert.equal(isPermissionMode(m), true);
  assert.equal(isPermissionMode('bypassPermissions'), false);
  assert.equal(isPermissionMode(''), false);
  assert.equal(isPermissionMode(undefined), false);
  assert.equal(isPermissionMode(null), false);
  assert.equal(isPermissionMode(3), false);
});

test('every SessionEvent kind the panel renders is representable', () => {
  // Compile-time exhaustiveness: if a `k` is removed from SessionEvent this
  // stops compiling, which is the point. The runtime assertion is incidental.
  const kinds: Array<SessionEvent['k']> = [
    'user', 'init', 'sdk', 'stream', 'result',
    'permission', 'permission_resolved', 'mode', 'compact', 'closed', 'error',
  ];
  assert.equal(new Set(kinds).size, kinds.length);
});
