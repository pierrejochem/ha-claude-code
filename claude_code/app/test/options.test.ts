import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeIsInsideRoots, resolveExtraSessionDirs, remoteControlBlocker, loadOptions } from '../src/options.js';
import type { AddonOptions } from '../src/options.js';

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

// ------------------------------------------------- extra session folders

const checks = {
  isInside: inside,
  hasProjects: (dir: string) => !dir.endsWith('/empty'),
  own: '/data/home/.claude',
};

test('keeps a config folder inside the roots that holds projects', () => {
  const { dirs, rejected } = resolveExtraSessionDirs(['/share/claude', '/homeassistant/.claude'], checks);
  assert.deepEqual(dirs, ['/share/claude', '/homeassistant/.claude']);
  assert.deepEqual(rejected, []);
});

test('reports each folder it will not use, so a typo is visible in the log', () => {
  const { dirs, rejected } = resolveExtraSessionDirs(
    ['/root/.claude', '/share/empty', '/data/home/.claude'],
    checks
  );
  assert.deepEqual(dirs, []);
  assert.deepEqual(rejected.map((r) => r.path), ['/root/.claude', '/share/empty', '/data/home/.claude']);
  assert.match(rejected[0].reason, /outside the folders/);
  assert.match(rejected[1].reason, /no projects folder/);
  assert.match(rejected[2].reason, /own session folder/);
});

test('normalises, dedupes and ignores blank entries', () => {
  const { dirs } = resolveExtraSessionDirs(
    ['/share/claude/', ' /share/claude ', '/share/other/../claude', '', '  '],
    checks
  );
  assert.deepEqual(dirs, ['/share/claude']);
});

test('survives an option that is not a list of strings', () => {
  assert.deepEqual(resolveExtraSessionDirs(undefined, checks).dirs, []);
  assert.deepEqual(resolveExtraSessionDirs('/share/claude', checks).dirs, []);
  assert.deepEqual(resolveExtraSessionDirs([42, null, '/share/claude'], checks).dirs, ['/share/claude']);
});

// ------------------------------------------------------- remote control

// Spelled out rather than taken from loadOptions(), which reads
// /data/options.json and would make these assertions depend on the machine.
const BASE: AddonOptions = {
  claude_oauth_token: '',
  anthropic_api_key: '',
  default_model: '',
  default_permission_mode: 'default',
  working_directory: '/homeassistant',
  expose_ha_api: true,
  protect_secrets: true,
  max_live_sessions: 3,
  idle_timeout_minutes: 20,
  extra_session_dirs: [],
  remote_control: false,
};

const opts = (over: Partial<AddonOptions> = {}): AddonOptions => ({ ...BASE, ...over });

test('loadOptions() reads the new options over the defaults', () => {
  const file = path.join(os.tmpdir(), `ha-claude-options-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ extra_session_dirs: ['/share/claude'], remote_control: true }));
  const previous = process.env.OPTIONS_PATH;
  process.env.OPTIONS_PATH = file;
  try {
    const loaded = loadOptions();
    assert.deepEqual(loaded.extra_session_dirs, ['/share/claude']);
    assert.equal(loaded.remote_control, true);
    // Untouched keys still come from the defaults.
    assert.equal(loaded.working_directory, '/homeassistant');
  } finally {
    if (previous === undefined) delete process.env.OPTIONS_PATH;
    else process.env.OPTIONS_PATH = previous;
    fs.rmSync(file, { force: true });
  }
});

test('a missing options file leaves both new options off', () => {
  const previous = process.env.OPTIONS_PATH;
  process.env.OPTIONS_PATH = path.join(os.tmpdir(), 'ha-claude-options-absent.json');
  try {
    assert.deepEqual(loadOptions().extra_session_dirs, []);
    assert.equal(loadOptions().remote_control, false);
  } finally {
    if (previous === undefined) delete process.env.OPTIONS_PATH;
    else process.env.OPTIONS_PATH = previous;
  }
});

test('remote control needs the subscription token', () => {
  assert.equal(remoteControlBlocker(opts({ remote_control: true, claude_oauth_token: 'sk-ant-oat-x' }), {}), null);
  assert.match(
    remoteControlBlocker(opts({ remote_control: true }), {}) ?? '',
    /no Claude subscription token/
  );
  assert.match(
    remoteControlBlocker(opts({ remote_control: true, claude_oauth_token: 'x', anthropic_api_key: 'sk-ant-y' }), {}) ?? '',
    /API key/
  );
});

test('remote control is off without the option, whatever the credentials', () => {
  assert.equal(remoteControlBlocker(opts({ claude_oauth_token: 'x' }), {}), null);
  assert.equal(remoteControlBlocker(opts({ anthropic_api_key: 'y' }), {}), null);
});

test('remote control does not work through a gateway', () => {
  const on = opts({ remote_control: true, claude_oauth_token: 'x' });
  assert.equal(remoteControlBlocker(on, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), null);
  assert.match(remoteControlBlocker(on, { ANTHROPIC_BASE_URL: 'http://gateway.local' }) ?? '', /only works against/);
});
