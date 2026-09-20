import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RESULT_CHARS,
  clip,
  slimStreamEvent,
  slimMessage,
  describeSuggestions,
  friendlyError,
  errorMessage,
} from '../src/wire.js';

// ------------------------------------------------------------------- clip

test('clip leaves short strings and non-strings alone', () => {
  assert.equal(clip('short'), 'short');
  assert.equal(clip(''), '');
  assert.equal(clip(undefined), undefined);
  assert.equal(clip(42), 42);
});

test('clip truncates long strings and says how much was dropped', () => {
  const long = 'x'.repeat(MAX_RESULT_CHARS + 500);
  const out = clip(long) as string;
  assert.ok(out.startsWith('x'.repeat(MAX_RESULT_CHARS)));
  assert.match(out, /\n… \(500 more characters not shown\)$/);
});

test('clip keeps a string exactly at the limit', () => {
  const exact = 'y'.repeat(MAX_RESULT_CHARS);
  assert.equal(clip(exact), exact);
});

// ------------------------------------------------------- slimStreamEvent

test('slimStreamEvent keeps text and thinking deltas', () => {
  assert.deepEqual(
    slimStreamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
    { type: 'content_block_delta', index: 1, text: 'hi' },
  );
  assert.deepEqual(
    slimStreamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'hm' } }),
    { type: 'content_block_delta', index: 2, thinking: 'hm' },
  );
});

test('slimStreamEvent drops signature deltas and unknown events', () => {
  assert.deepEqual(
    slimStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
    { type: 'noop' },
  );
  assert.deepEqual(slimStreamEvent({ type: 'something_else' }), { type: 'noop' });
});

test('slimStreamEvent keeps block starts with only type and name', () => {
  assert.deepEqual(
    slimStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 'tu_1', input: {} } }),
    { type: 'content_block_start', index: 0, block: { type: 'tool_use', name: 'Bash' } },
  );
});

test('slimStreamEvent keeps the message and block boundaries', () => {
  assert.deepEqual(slimStreamEvent({ type: 'message_start', message: { usage: { input_tokens: 9 } } }), { type: 'message_start' });
  assert.deepEqual(slimStreamEvent({ type: 'message_stop' }), { type: 'message_stop' });
  assert.deepEqual(slimStreamEvent({ type: 'content_block_stop', index: 3 }), { type: 'content_block_stop', index: 3 });
});

// ----------------------------------------------------------- slimMessage

test('slimMessage passes a string body through clip', () => {
  assert.deepEqual(slimMessage({ role: 'user', content: 'hello' }), { role: 'user', content: 'hello' });
  const long = 'z'.repeat(MAX_RESULT_CHARS + 1);
  const out = slimMessage({ role: 'user', content: long });
  assert.match(out.content as string, /more characters not shown\)$/);
});

test('slimMessage reshapes tool_result blocks and clips their text', () => {
  const long = 'q'.repeat(MAX_RESULT_CHARS + 10);
  const out = slimMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: long }, { type: 'image', source: { data: 'BIG' } }] }],
  });
  const block = (out.content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'tu_1');
  assert.equal(block.is_error, true);
  assert.match(block.content[0].text, /more characters not shown\)$/);
  assert.deepEqual(block.content[1], { type: 'image' }, 'image payloads are dropped, only the type survives');
});

test('slimMessage strips image payloads and keeps thinking text', () => {
  const out = slimMessage({
    role: 'assistant',
    content: [
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'thinking', thinking: 'considering', signature: 'sig' },
    ],
  });
  assert.deepEqual((out.content as any[])[0], { type: 'image' });
  assert.deepEqual((out.content as any[])[1], { type: 'thinking', thinking: 'considering' });
});

test('slimMessage passes other blocks through untouched', () => {
  const out = slimMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } }] });
  assert.deepEqual((out.content as any[])[0], { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } });
});

test('slimMessage survives a missing message', () => {
  assert.deepEqual(slimMessage(undefined), { role: undefined, content: undefined });
});

test('slimMessage passes a string tool_result content through clip', () => {
  const out = slimMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_3', is_error: false, content: 'short result' }],
  });
  const block = (out.content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'tu_3');
  assert.equal(block.is_error, false);
  assert.equal(block.content, 'short result');

  const long = 'r'.repeat(MAX_RESULT_CHARS + 25);
  const outLong = slimMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_4', is_error: false, content: long }],
  });
  const blockLong = (outLong.content as any[])[0];
  assert.match(blockLong.content, /more characters not shown\)$/);
});

test('slimMessage handles tool_result with no content field', () => {
  const out = slimMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_5', is_error: true }],
  });
  const block = (out.content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'tu_5');
  assert.equal(block.is_error, true);
  assert.equal(block.content, undefined);
});

// --------------------------------------------------- describeSuggestions

test('describeSuggestions formats allow rules', () => {
  assert.equal(
    describeSuggestions([{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }, { toolName: 'Read' }] }]),
    'Bash(ls:*), Read',
  );
});

test('describeSuggestions formats directories and modes', () => {
  assert.equal(describeSuggestions([{ type: 'addDirectories', directories: ['/share'] }]), 'files in /share');
  assert.equal(describeSuggestions([{ type: 'setMode', mode: 'acceptEdits' }]), 'switch to acceptEdits mode');
});

test('describeSuggestions ignores deny rules and caps at three', () => {
  assert.equal(describeSuggestions([{ type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] }]), null);
  const many = [{ type: 'addRules', behavior: 'allow', rules: [1, 2, 3, 4, 5].map((n) => ({ toolName: `T${n}` })) }];
  assert.equal(describeSuggestions(many), 'T1, T2, T3');
});

test('describeSuggestions returns null when there is nothing to say', () => {
  assert.equal(describeSuggestions([]), null);
});

// -------------------------------------------------------- error messages

test('friendlyError explains a missing native binary', () => {
  const out = friendlyError(new Error('Native CLI binary not found'));
  assert.match(out, /Native CLI binary not found/);
  assert.match(out, /Rebuild the add-on/);
});

test('friendlyError explains an unexpected exit', () => {
  assert.match(friendlyError(new Error('Process exited with code 1')), /The add-on log has the details/);
});

test('friendlyError passes anything else through', () => {
  assert.equal(friendlyError(new Error('boom')), 'boom');
});

test('errorMessage handles Errors, strings and junk', () => {
  assert.equal(errorMessage(new Error('bad')), 'bad');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage({ message: 'shaped' }), 'shaped');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
});

test('errorMessage matches String(err?.message || err) on falsy messages', () => {
  // `new Error()` has an empty message; the expression this replaces falls
  // through to String(err) and yields 'Error'. A blank string here would put
  // an empty error row in the panel.
  assert.equal(errorMessage(new Error()), 'Error');
  assert.equal(errorMessage(new Error('')), 'Error');
  assert.equal(errorMessage({ message: '' }), '[object Object]');
  assert.equal(errorMessage(0), '0');
});

test('friendlyError does not blank out an empty-message Error', () => {
  assert.equal(friendlyError(new Error()), 'Error');
});
