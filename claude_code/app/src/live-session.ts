import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from './input-queue.js';
import { slimMessage, slimStreamEvent, describeSuggestions, friendlyError, errorMessage } from './wire.js';
import type { PermissionSuggestion } from './wire.js';
import type {
  SessionSummary,
  SessionEvent,
  LogEntry,
  EvStream,
  PermissionMode,
  SessionStatus,
  ModelOption,
  ImageAttachment,
  PermissionDecision,
} from './shared/protocol.js';

const MAX_LOG = 3000;

export interface LiveSessionInit {
  cwd: string;
  model: string | null;
  mode: PermissionMode;
  resume?: string;
  historyCount: number;
  sdkOptions: Record<string, unknown>;
  idleMs: number;
}

/** Pending `canUseTool` prompt, keyed by requestId while the UI decides. */
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}

type PermissionResult =
  | { behavior: 'allow'; updatedInput: unknown; updatedPermissions?: PermissionSuggestion[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface LiveSession {
  on(event: 'event', listener: (entry: LogEntry) => void): this;
  on(event: 'stream', listener: (ev: EvStream) => void): this;
  on(event: 'meta', listener: () => void): this;
  on(event: 'models', listener: (models: ModelOption[]) => void): this;
  on(event: 'closed', listener: () => void): this;

  emit(event: 'event', entry: LogEntry): boolean;
  emit(event: 'stream', ev: EvStream): boolean;
  emit(event: 'meta'): boolean;
  emit(event: 'models', models: ModelOption[]): boolean;
  emit(event: 'closed'): boolean;
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
  readonly liveId: string;
  cwd: string;
  model: string | null;
  mode: PermissionMode;
  sessionId: string | null;
  resumed: boolean;
  historyCount: number;
  title: string | null;
  status: SessionStatus;
  createdAt: number;
  lastActivity: number;
  models: ModelOption[] | null;

  private log: LogEntry[];
  private seq: number;
  private pending: Map<string, PendingPermission>;
  private input: InputQueue;
  private idleMs: number;
  private idleTimer: NodeJS.Timeout | null;
  closed: boolean;

  private q: ReturnType<typeof query>;

  constructor({ cwd, model, mode, resume, historyCount, sdkOptions, idleMs }: LiveSessionInit) {
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
      // Double cast: InputQueue's items carry SdkUserTurn's narrower shape
      // (type/message/parent_tool_use_id), while the SDK's SDKUserMessage
      // additionally declares session_id/uuid/etc. The SDK's streaming-input
      // mode accepts the smaller object at runtime, and the original
      // JavaScript passed this identical object.
      prompt: this.input as unknown as AsyncIterable<SDKUserMessage>,
      options: {
        ...sdkOptions,
        cwd,
        model: this.model || undefined,
        permissionMode: this.mode,
        resume: resume || undefined,
        includePartialMessages: true,
        // Bridges PermissionResult, a hand-written mirror of the SDK's
        // permission-result union, back to the SDK's own CanUseTool type.
        canUseTool: ((toolName: Parameters<CanUseTool>[0], input: Parameters<CanUseTool>[1], opts: Parameters<CanUseTool>[2]) =>
          this.askPermission(toolName, input, opts)) as CanUseTool,
        stderr: (data: string) => {
          const line = String(data).trim();
          if (line) console.error(`[claude ${this.liveId.slice(0, 8)}] ${line}`);
        },
      },
    });
    this.pump();
  }

  summary(): SessionSummary {
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
  send(text: string, images: ImageAttachment[] = []): void {
    if (this.closed) throw new Error('This session is closed.');
    const content: unknown[] = [];
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    if (text) content.push({ type: 'text', text });
    if (!content.length) return;

    if (!this.title && text) this.title = text.replace(/\s+/g, ' ').slice(0, 80);
    this.clearIdle();
    this.setStatus('running');
    // Images are echoed as a count only; the log should not hold megabytes of base64.
    this.record({ k: 'user', text, images: images.length });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: images.length ? content : text },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    for (const [requestId] of this.pending) {
      this.resolvePermission(requestId, { behavior: 'deny', message: 'The user stopped the task.', interrupt: true }, 'deny');
    }
    try {
      await this.q.interrupt();
    } catch (err) {
      console.error('interrupt failed:', errorMessage(err));
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
    this.mode = mode;
    this.record({ k: 'mode', mode });
    this.emit('meta');
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model || undefined);
    this.model = model || null;
    this.emit('meta');
  }

  /** decision: { behavior: 'allow' | 'always' | 'deny', message?, answers? } */
  answerPermission(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;

    let result: PermissionResult;
    if (decision.behavior === 'deny') {
      const note = (decision.message || '').trim();
      result = {
        behavior: 'deny',
        message: note ? `The user declined this action and said: ${note}` : 'The user declined this action.',
      };
    } else if (p.toolName === 'AskUserQuestion') {
      // Only reached when toolName === 'AskUserQuestion'; a null input throws
      // here exactly as `p.input.questions` did in the JavaScript.
      const input = p.input as { questions: unknown };
      result = {
        behavior: 'allow',
        updatedInput: { questions: input.questions, answers: decision.answers || {} },
      };
    } else {
      result = { behavior: 'allow', updatedInput: p.input };
      if (decision.behavior === 'always' && p.suggestions?.length) result.updatedPermissions = p.suggestions;
    }
    this.resolvePermission(requestId, result, decision.behavior);
    return true;
  }

  replaySince(since = 0): LogEntry[] {
    return this.log.filter((entry) => entry.seq > since);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    for (const [requestId] of this.pending) {
      this.resolvePermission(requestId, { behavior: 'deny', message: 'The session was closed.' }, 'deny');
    }
    this.input.end();
    try {
      this.q.close();
    } catch {
      /* already gone */
    }
    this.status = 'closed';
    this.record({ k: 'closed', reason });
    this.emit('meta');
    this.emit('closed');
  }

  // ---------------------------------------------------------------- internals

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q) this.onMessage(m);
      if (!this.closed) this.close('ended');
    } catch (err) {
      if (this.closed) return;
      console.error(`[session ${this.liveId.slice(0, 8)}]`, err);
      this.record({ k: 'error', message: friendlyError(err) });
      this.close('error');
    }
  }

  private onMessage(m: SDKMessage): void {
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
          this.record({ k: 'init', sessionId: m.session_id, model: m.model, cwd: m.cwd, mode: m.permissionMode });
          if (changed) this.emit('meta');
          this.loadModels();
        } else if (m.subtype === 'compact_boundary') {
          this.record({ k: 'compact' });
        }
        return;

      case 'assistant':
      case 'user':
        if (m.type === 'user' && 'isReplay' in m && m.isReplay) return;
        this.record({
          k: 'sdk',
          m: { type: m.type, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id ?? null, message: slimMessage(m.message) },
        });
        return;

      case 'result': {
        const result = 'result' in m ? m.result : undefined;
        const errors = 'errors' in m ? m.errors : undefined;
        this.record({
          k: 'result',
          subtype: m.subtype,
          isError: Boolean(m.is_error),
          text: m.is_error ? result || (errors || []).join('\n') || m.subtype : null,
          durationMs: m.duration_ms,
          turns: m.num_turns,
          costUsd: m.total_cost_usd,
        });
        this.setStatus('idle');
        this.armIdle();
        return;
      }

      default:
        return;
    }
  }

  private async loadModels(): Promise<void> {
    if (this.models) return;
    try {
      const models = await this.q.supportedModels();
      this.models = models.map((x) => ({ value: x.value, name: x.displayName, description: x.description }));
      this.emit('models', this.models);
    } catch {
      /* optional */
    }
  }

  private askPermission(
    toolName: Parameters<CanUseTool>[0],
    input: Parameters<CanUseTool>[1],
    opts: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = opts.toolUseID || randomUUID();
      const suggestions = opts.suppressAlwaysAllowRule ? [] : opts.suggestions || [];
      this.pending.set(requestId, { resolve, toolName, input, suggestions });

      opts.signal?.addEventListener(
        'abort',
        () => this.resolvePermission(requestId, { behavior: 'deny', message: 'Cancelled.' }, 'cancelled'),
        { once: true }
      );

      this.record({
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
      this.setStatus('waiting');
    });
  }

  private resolvePermission(requestId: string, result: PermissionResult, behavior: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(result);
    this.record({ k: 'permission_resolved', requestId, behavior });
    if (!this.closed && this.status === 'waiting' && this.pending.size === 0) this.setStatus('running');
    else this.emit('meta');
  }

  private record(ev: SessionEvent): void {
    const entry = { seq: ++this.seq, ev };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.emit('event', entry);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('meta');
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.idleMs) return;
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle') this.close('idle');
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
