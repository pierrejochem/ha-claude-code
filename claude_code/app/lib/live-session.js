import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MAX_LOG = 3000;
const MAX_RESULT_CHARS = 30000;

/** Async-iterable queue: the SDK pulls user messages from it for as long as the session lives. */
class InputQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.done = false;
  }
  push(item) {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * One running Claude Code process.
 *
 * Emits:
 *   'event'  (entry)  { seq, ev }  logged, replayable
 *   'stream' (ev)     token deltas, broadcast only, never logged
 *   'meta'   ()       status / title / sessionId changed
 *   'closed' ()
 */
export class LiveSession extends EventEmitter {
  constructor({ cwd, model, mode, resume, historyCount, sdkOptions, idleMs }) {
    super();
    this.liveId = randomUUID();
    this.cwd = cwd;
    this.model = model || null;
    this.mode = mode || 'default';
    this.sessionId = resume || null;
    this.resumed = Boolean(resume);
    this.historyCount = historyCount || 0;
    this.title = null;
    this.status = 'starting'; // starting | running | waiting | idle | closed
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.models = null;

    this.log = [];
    this.seq = 0;
    this.pending = new Map(); // requestId -> { resolve, input, suggestions }
    this.input = new InputQueue();
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.closed = false;

    this.q = query({
      prompt: this.input,
      options: {
        ...sdkOptions,
        cwd,
        model: this.model || undefined,
        permissionMode: this.mode,
        resume: resume || undefined,
        includePartialMessages: true,
        canUseTool: (toolName, input, opts) => this.#askPermission(toolName, input, opts),
        stderr: (data) => {
          const line = String(data).trim();
          if (line) console.error(`[claude ${this.liveId.slice(0, 8)}] ${line}`);
        },
      },
    });
    this.#pump();
  }

  summary() {
    return {
      liveId: this.liveId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      mode: this.mode,
      title: this.title,
      status: this.status,
      resumed: this.resumed,
      historyCount: this.historyCount,
      pending: this.pending.size,
      lastActivity: this.lastActivity,
    };
  }

  /** Send a user turn. `images` is [{ mediaType, data }] with base64 data. */
  send(text, images = []) {
    if (this.closed) throw new Error('This session is closed.');
    const content = [];
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    if (text) content.push({ type: 'text', text });
    if (!content.length) return;

    if (!this.title && text) this.title = text.replace(/\s+/g, ' ').slice(0, 80);
    this.#clearIdle();
    this.#setStatus('running');
    // Images are echoed as a count only; the log should not hold megabytes of base64.
    this.#record({ k: 'user', text, images: images.length });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: images.length ? content : text },
      parent_tool_use_id: null,
    });
  }

  async interrupt() {
    for (const [requestId] of this.pending) {
      this.#resolvePermission(requestId, { behavior: 'deny', message: 'The user stopped the task.', interrupt: true }, 'deny');
    }
    try {
      await this.q.interrupt();
    } catch (err) {
      console.error('interrupt failed:', err?.message || err);
    }
  }

  async setMode(mode) {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
    this.#record({ k: 'mode', mode });
    this.emit('meta');
  }

  async setModel(model) {
    await this.q.setModel(model || undefined);
    this.model = model || null;
    this.emit('meta');
  }

  /** decision: { behavior: 'allow' | 'always' | 'deny', message?, answers? } */
  answerPermission(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return false;

    let result;
    if (decision.behavior === 'deny') {
      const note = (decision.message || '').trim();
      result = {
        behavior: 'deny',
        message: note ? `The user declined this action and said: ${note}` : 'The user declined this action.',
      };
    } else if (p.toolName === 'AskUserQuestion') {
      result = {
        behavior: 'allow',
        updatedInput: { questions: p.input.questions, answers: decision.answers || {} },
      };
    } else {
      result = { behavior: 'allow', updatedInput: p.input };
      if (decision.behavior === 'always' && p.suggestions?.length) result.updatedPermissions = p.suggestions;
    }
    this.#resolvePermission(requestId, result, decision.behavior);
    return true;
  }

  replaySince(since = 0) {
    return this.log.filter((entry) => entry.seq > since);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.#clearIdle();
    for (const [requestId] of this.pending) {
      this.#resolvePermission(requestId, { behavior: 'deny', message: 'The session was closed.' }, 'deny');
    }
    this.input.end();
    try {
      this.q.close();
    } catch {
      /* already gone */
    }
    this.status = 'closed';
    this.#record({ k: 'closed', reason });
    this.emit('meta');
    this.emit('closed');
  }

  // ---------------------------------------------------------------- internals

  async #pump() {
    try {
      for await (const m of this.q) this.#onMessage(m);
      if (!this.closed) this.close('ended');
    } catch (err) {
      if (this.closed) return;
      console.error(`[session ${this.liveId.slice(0, 8)}]`, err);
      this.#record({ k: 'error', message: friendlyError(err) });
      this.close('error');
    }
  }

  #onMessage(m) {
    this.lastActivity = Date.now();
    switch (m.type) {
      case 'stream_event':
        if (m.parent_tool_use_id) return; // subagent chatter is summarised by its tool row
        this.emit('stream', { k: 'stream', event: slimStreamEvent(m.event) });
        return;

      case 'system':
        if (m.subtype === 'init') {
          const changed = this.sessionId !== m.session_id;
          this.sessionId = m.session_id;
          if (m.model) this.model = this.model || m.model;
          this.#record({ k: 'init', sessionId: m.session_id, model: m.model, cwd: m.cwd, mode: m.permissionMode });
          if (changed) this.emit('meta');
          this.#loadModels();
        } else if (m.subtype === 'compact_boundary') {
          this.#record({ k: 'compact' });
        }
        return;

      case 'assistant':
      case 'user':
        if (m.type === 'user' && m.isReplay) return;
        this.#record({
          k: 'sdk',
          m: { type: m.type, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id ?? null, message: slimMessage(m.message) },
        });
        return;

      case 'result':
        this.#record({
          k: 'result',
          subtype: m.subtype,
          isError: Boolean(m.is_error),
          text: m.is_error ? m.result || (m.errors || []).join('\n') || m.subtype : null,
          durationMs: m.duration_ms,
          turns: m.num_turns,
          costUsd: m.total_cost_usd,
        });
        this.#setStatus('idle');
        this.#armIdle();
        return;

      default:
        return;
    }
  }

  async #loadModels() {
    if (this.models) return;
    try {
      const models = await this.q.supportedModels();
      this.models = models.map((x) => ({ value: x.value, name: x.displayName, description: x.description }));
      this.emit('models', this.models);
    } catch {
      /* optional */
    }
  }

  #askPermission(toolName, input, opts) {
    return new Promise((resolve) => {
      const requestId = opts.toolUseID || randomUUID();
      const suggestions = opts.suppressAlwaysAllowRule ? [] : opts.suggestions || [];
      this.pending.set(requestId, { resolve, toolName, input, suggestions });

      opts.signal?.addEventListener(
        'abort',
        () => this.#resolvePermission(requestId, { behavior: 'deny', message: 'Cancelled.' }, 'cancelled'),
        { once: true }
      );

      this.#record({
        k: 'permission',
        requestId,
        toolName,
        input,
        title: opts.title || null,
        description: opts.description || null,
        reason: opts.decisionReason || null,
        blockedPath: opts.blockedPath || null,
        canAlways: suggestions.length > 0,
        alwaysLabel: describeSuggestions(suggestions),
        subagent: Boolean(opts.agentID),
      });
      this.#setStatus('waiting');
    });
  }

  #resolvePermission(requestId, result, behavior) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(result);
    this.#record({ k: 'permission_resolved', requestId, behavior });
    if (!this.closed && this.status === 'waiting' && this.pending.size === 0) this.#setStatus('running');
    else this.emit('meta');
  }

  #record(ev) {
    const entry = { seq: ++this.seq, ev };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.emit('event', entry);
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('meta');
  }

  #armIdle() {
    this.#clearIdle();
    if (!this.idleMs) return;
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle') this.close('idle');
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  #clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

// ------------------------------------------------------------------ helpers

function slimStreamEvent(event) {
  // Forward only what the transcript renders; drop usage blobs and signatures.
  switch (event.type) {
    case 'message_start':
      return { type: 'message_start' };
    case 'content_block_start':
      return { type: event.type, index: event.index, block: { type: event.content_block?.type, name: event.content_block?.name } };
    case 'content_block_delta': {
      const d = event.delta || {};
      if (d.type === 'text_delta') return { type: event.type, index: event.index, text: d.text };
      if (d.type === 'thinking_delta') return { type: event.type, index: event.index, thinking: d.thinking };
      return { type: 'noop' };
    }
    case 'content_block_stop':
      return { type: event.type, index: event.index };
    case 'message_stop':
      return { type: 'message_stop' };
    default:
      return { type: 'noop' };
  }
}

function clip(text) {
  if (typeof text !== 'string' || text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} more characters not shown)`;
}

function slimMessage(message) {
  if (!message || typeof message.content === 'string') return { role: message?.role, content: clip(message?.content) };
  const content = (message.content || []).map((block) => {
    if (block.type === 'tool_result') {
      const inner = Array.isArray(block.content)
        ? block.content.map((c) => (c.type === 'text' ? { type: 'text', text: clip(c.text) } : { type: c.type }))
        : clip(block.content);
      return { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: Boolean(block.is_error), content: inner };
    }
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking };
    if (block.type === 'image') return { type: 'image' };
    return block;
  });
  return { role: message.role, content };
}

function describeSuggestions(suggestions) {
  const rules = [];
  for (const s of suggestions) {
    if (s.type === 'addRules' && s.behavior === 'allow') {
      for (const r of s.rules || []) rules.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (s.type === 'addDirectories') {
      for (const d of s.directories || []) rules.push(`files in ${d}`);
    } else if (s.type === 'setMode') {
      rules.push(`switch to ${s.mode} mode`);
    }
  }
  return rules.slice(0, 3).join(', ') || null;
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/Native CLI binary/.test(msg)) {
    return `${msg}\nThe Claude Code binary for this platform was not installed. Rebuild the add-on and check the build log for npm errors.`;
  }
  if (/exited with code/.test(msg)) {
    return `${msg}\nClaude Code stopped unexpectedly. The add-on log has the details.`;
  }
  return msg;
}
