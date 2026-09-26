import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRemoteControlSetting, SETTINGS_KEY } from '../src/remote-control.js';

async function configDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'remote-control-'));
}

const settingsIn = (dir: string): string => path.join(dir, 'settings.json');
const readSettings = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fsp.readFile(settingsIn(dir), 'utf8')) as Record<string, unknown>;

test('writes the key into a config folder that has no settings file yet', async () => {
  const dir = await configDir();
  assert.deepEqual(await applyRemoteControlSetting(true, dir), { state: 'set' });
  assert.deepEqual(await readSettings(dir), { [SETTINGS_KEY]: true });
});

test('leaves the rest of the settings file alone, rules included', async () => {
  const dir = await configDir();
  const existing = {
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    theme: 'dark',
  };
  await fsp.writeFile(settingsIn(dir), JSON.stringify(existing));

  await applyRemoteControlSetting(true, dir);
  assert.deepEqual(await readSettings(dir), { ...existing, [SETTINGS_KEY]: true });

  assert.deepEqual(await applyRemoteControlSetting(false, dir), { state: 'cleared' });
  assert.deepEqual(await readSettings(dir), existing);
});

test('does not rewrite a file that already says what it should', async () => {
  const dir = await configDir();
  await applyRemoteControlSetting(true, dir);
  const before = (await fsp.stat(settingsIn(dir))).mtimeMs;

  assert.deepEqual(await applyRemoteControlSetting(true, dir), { state: 'unchanged' });
  assert.equal((await fsp.stat(settingsIn(dir))).mtimeMs, before);
});

test('turning it off without a settings file writes nothing', async () => {
  const dir = await configDir();
  assert.deepEqual(await applyRemoteControlSetting(false, dir), { state: 'unchanged' });
  await assert.rejects(fsp.lstat(settingsIn(dir)));
});

test('keeps a hand-set false rather than deleting it', async () => {
  const dir = await configDir();
  await fsp.writeFile(settingsIn(dir), JSON.stringify({ [SETTINGS_KEY]: false }));
  assert.deepEqual(await applyRemoteControlSetting(false, dir), { state: 'unchanged' });
  assert.deepEqual(await readSettings(dir), { [SETTINGS_KEY]: false });
});

test('refuses to touch a settings file it cannot parse', async () => {
  const dir = await configDir();
  await fsp.writeFile(settingsIn(dir), '{ this is not json');
  const outcome = await applyRemoteControlSetting(true, dir);
  assert.equal(outcome.state, 'failed');
  assert.equal(await fsp.readFile(settingsIn(dir), 'utf8'), '{ this is not json');
});

test('treats an empty settings file as no settings at all', async () => {
  const dir = await configDir();
  await fsp.writeFile(settingsIn(dir), '\n');
  assert.deepEqual(await applyRemoteControlSetting(true, dir), { state: 'set' });
  assert.deepEqual(await readSettings(dir), { [SETTINGS_KEY]: true });
});
