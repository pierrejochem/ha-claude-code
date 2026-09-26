import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mirrorSessions, forgetMirroredSession } from '../src/session-mirror.js';

async function write(file: string, body = '{"type":"user"}\n'): Promise<string> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  return file;
}

/** A temp root holding `own` (the add-on's config folder) and `extra` folders. */
async function sandbox(): Promise<{ own: string; extra: (name: string) => string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-mirror-'));
  return { own: path.join(root, 'own'), extra: (name) => path.join(root, name) };
}

const transcript = (dir: string, project: string, id: string): string =>
  path.join(dir, 'projects', project, `${id}.jsonl`);

const read = (file: string): Promise<string> => fsp.readFile(file, 'utf8');

/** Nudge a file's mtime forward: same-millisecond writes would look unchanged. */
async function touch(file: string, body: string): Promise<void> {
  await fsp.writeFile(file, body);
  const later = new Date(Date.now() + 2000);
  await fsp.utimes(file, later, later);
}

test('copies transcripts from an extra folder under the same project name', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'), 'first\n');
  await write(transcript(shared, '-root-other', 'bbbb'));

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 2);
  assert.equal(report.sources, 1);
  assert.deepEqual(report.errors, []);

  // A real file, not a link: the SDK's listing skips links.
  const copy = transcript(own, '-share-work', 'aaaa');
  assert.equal((await fsp.lstat(copy)).isFile(), true);
  assert.equal(await read(copy), 'first\n');
  assert.ok(await fsp.stat(transcript(own, '-root-other', 'bbbb')));
});

test('is idempotent: a second run copies nothing', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));

  assert.equal((await mirrorSessions([shared], own)).copied, 1);
  const again = await mirrorSessions([shared], own);
  assert.deepEqual({ copied: again.copied, pruned: again.pruned, adopted: again.adopted }, { copied: 0, pruned: 0, adopted: 0 });
});

test('refreshes a copy when the session it came from grows', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  const source = await write(transcript(shared, '-share-work', 'aaaa'), 'one\n');
  await mirrorSessions([shared], own);

  await touch(source, 'one\ntwo\n');
  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 1);
  assert.equal(await read(transcript(own, '-share-work', 'aaaa')), 'one\ntwo\n');
});

test("never writes over one of the add-on's own transcripts", async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'), 'borrowed\n');
  await write(transcript(own, '-share-work', 'aaaa'), 'ours\n');

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 0);
  assert.equal(await read(transcript(own, '-share-work', 'aaaa')), 'ours\n');
});

test('keeps a copy that was continued here, even when the source moves on', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  const source = await write(transcript(shared, '-share-work', 'aaaa'), 'one\n');
  await mirrorSessions([shared], own);

  // What resuming the session in the panel does to the copy.
  const copy = transcript(own, '-share-work', 'aaaa');
  await touch(copy, 'one\ncontinued here\n');
  await touch(source, 'one\ncontinued there\n');

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 0);
  assert.equal(report.adopted, 1);
  assert.equal(await read(copy), 'one\ncontinued here\n');

  // Adopted for good: it is the add-on's own transcript from here on.
  await touch(source, 'one\ncontinued there\nand again\n');
  const later = await mirrorSessions([shared], own);
  assert.equal(later.copied, 0);
  assert.equal(await read(copy), 'one\ncontinued here\n');
});

test('ignores anything that is not a .jsonl transcript', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await write(path.join(shared, 'projects', '-share-work', 'notes.txt'));
  await write(path.join(shared, 'projects', 'loose.jsonl'));

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 1);
  await assert.rejects(fsp.lstat(path.join(own, 'projects', '-share-work', 'notes.txt')));
  await assert.rejects(fsp.lstat(path.join(own, 'projects', 'loose.jsonl')));
});

test('prunes a copy whose source was deleted, and the folder it emptied', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  const source = await write(transcript(shared, '-share-work', 'aaaa'));
  await mirrorSessions([shared], own);

  await fsp.rm(source);
  const report = await mirrorSessions([shared], own);
  assert.equal(report.pruned, 1);
  await assert.rejects(fsp.lstat(path.join(own, 'projects', '-share-work')));
});

test('prunes copies from a folder that is no longer configured', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await mirrorSessions([shared], own);

  const report = await mirrorSessions([], own);
  assert.equal(report.pruned, 1);
  assert.equal(report.sources, 0);
  // The source is untouched: unconfiguring a folder must not delete sessions.
  assert.ok(await fsp.stat(transcript(shared, '-share-work', 'aaaa')));
});

test('keeps a transcript of ours in a folder that also held copies', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await write(transcript(own, '-share-work', 'cccc'), 'ours\n');
  await mirrorSessions([shared], own);

  await mirrorSessions([], own);
  assert.equal(await read(transcript(own, '-share-work', 'cccc')), 'ours\n');
});

test('takes the first configured folder when two hold the same session id', async () => {
  const { own, extra } = await sandbox();
  const first = extra('first');
  const second = extra('second');
  await write(transcript(first, '-share-work', 'aaaa'), 'from first\n');
  await write(transcript(second, '-share-work', 'aaaa'), 'from second\n');

  await mirrorSessions([first, second], own);
  assert.equal(await read(transcript(own, '-share-work', 'aaaa')), 'from first\n');
  // Stable across runs rather than alternating between the two.
  const again = await mirrorSessions([first, second], own);
  assert.equal(again.copied, 0);
  assert.equal(await read(transcript(own, '-share-work', 'aaaa')), 'from first\n');
});

test('a missing extra folder is skipped, not an error', async () => {
  const { own, extra } = await sandbox();
  const report = await mirrorSessions([extra('nothing-here')], own);
  assert.deepEqual(report, { sources: 0, copied: 0, pruned: 0, adopted: 0, skipped: 0, errors: [] });
});

test('leaves no index file behind once nothing is borrowed', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await mirrorSessions([shared], own);
  assert.ok(await fsp.stat(path.join(own, '.ha-borrowed-sessions.json')));

  await mirrorSessions([], own);
  await assert.rejects(fsp.lstat(path.join(own, '.ha-borrowed-sessions.json')));
});

test('does not copy a borrowed session in again once it was deleted here', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  const source = await write(transcript(shared, '-share-work', 'aaaa'), 'borrowed\n');
  await write(transcript(shared, '-share-work', 'bbbb'));
  await mirrorSessions([shared], own);

  // What the delete route does: the transcript goes, then the record.
  const copy = transcript(own, '-share-work', 'aaaa');
  await fsp.rm(copy);
  assert.equal(await forgetMirroredSession(own, 'aaaa'), true);

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 0);
  assert.equal(report.skipped, 1);
  await assert.rejects(fsp.lstat(copy));
  // The source is untouched, and the session beside it still mirrors.
  assert.equal(await read(source), 'borrowed\n');
  assert.ok(await fsp.stat(transcript(own, '-share-work', 'bbbb')));

  // Still gone after the source moves on, which would otherwise refresh it.
  await touch(source, 'borrowed\nmore\n');
  const later = await mirrorSessions([shared], own);
  assert.equal(later.skipped, 1);
  await assert.rejects(fsp.lstat(copy));
});

test('forgets the deletion once nothing would bring the session back', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  const source = await write(transcript(shared, '-share-work', 'aaaa'));
  await mirrorSessions([shared], own);
  await fsp.rm(transcript(own, '-share-work', 'aaaa'));
  await forgetMirroredSession(own, 'aaaa');
  await mirrorSessions([shared], own);

  // The source goes: there is nothing left to hold the deletion against.
  await fsp.rm(source);
  await mirrorSessions([shared], own);
  await assert.rejects(fsp.lstat(path.join(own, '.ha-borrowed-sessions.json')));

  // A session created there later, reusing the id, is borrowed like any other.
  await write(transcript(shared, '-share-work', 'aaaa'), 'a new one\n');
  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 1);
  assert.equal(report.skipped, 0);
  assert.equal(await read(transcript(own, '-share-work', 'aaaa')), 'a new one\n');
});

test("deleting one of the add-on's own sessions records nothing", async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await write(transcript(own, '-share-other', 'cccc'), 'ours\n');
  await mirrorSessions([shared], own);

  assert.equal(await forgetMirroredSession(own, 'cccc'), false);
  // The borrowed session's record is left exactly as it was.
  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.pruned, 0);
});

test('reads an index written before deletions were recorded', async () => {
  const { own, extra } = await sandbox();
  const shared = extra('shared');
  await write(transcript(shared, '-share-work', 'aaaa'));
  await mirrorSessions([shared], own);

  // 0.3.0's shape: the copy records at the top level, with no `copies` key.
  const indexFile = path.join(own, '.ha-borrowed-sessions.json');
  const index = JSON.parse(await read(indexFile)) as { copies: Record<string, unknown> };
  await fsp.writeFile(indexFile, JSON.stringify(index.copies));

  const report = await mirrorSessions([shared], own);
  assert.equal(report.copied, 0);
  assert.equal(report.pruned, 0);
  assert.equal(report.adopted, 0);
});
