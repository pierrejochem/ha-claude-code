import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../src/input-queue.js';
import type { SdkUserTurn } from '../src/input-queue.js';

const turn = (text: string): SdkUserTurn => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

test('delivers items pushed before the consumer asks', async () => {
  const q = new InputQueue();
  q.push(turn('one'));
  q.push(turn('two'));
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual((await it.next()).value, turn('one'));
  assert.deepEqual((await it.next()).value, turn('two'));
});

test('delivers items pushed after the consumer is already waiting', async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.push(turn('later'));
  assert.deepEqual((await pending).value, turn('later'));
});

test('end() releases a waiting consumer', async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.end();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test('end() closes the queue to further pushes', async () => {
  const q = new InputQueue();
  q.end();
  q.push(turn('ignored'));
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('return() ends the queue', async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.return!(), { value: undefined, done: true });
  q.push(turn('ignored'));
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('drains buffered items before reporting done', async () => {
  const q = new InputQueue();
  q.push(turn('buffered'));
  q.end();
  const seen: string[] = [];
  for await (const item of q) seen.push(String(item.message.content));
  assert.deepEqual(seen, ['buffered']);
});
