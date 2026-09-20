// SDK-to-wire mappers: convert Agent SDK message shapes into the narrower
// shapes the browser panel renders. Ported from lib/live-session.js:343-410
// (plus MAX_RESULT_CHARS from line 6). Kept in their own module because a
// porting mistake here would silently reshape data rather than error.

import type { WireStreamEvent, WireMessage, WireBlock } from './shared/protocol.js';

export const MAX_RESULT_CHARS = 30000;

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function slimStreamEvent(event: unknown): WireStreamEvent {
  // Forward only what the transcript renders; drop usage blobs and signatures.
  const e = rec(event);
  switch (e.type) {
    case 'message_start':
      return { type: 'message_start' };
    case 'content_block_start': {
      const block = rec(e.content_block);
      return {
        type: 'content_block_start',
        index: e.index as number,
        block: { type: block.type as string | undefined, name: block.name as string | undefined },
      };
    }
    case 'content_block_delta': {
      const d = rec(e.delta);
      if (d.type === 'text_delta') return { type: 'content_block_delta', index: e.index as number, text: d.text as string };
      if (d.type === 'thinking_delta') return { type: 'content_block_delta', index: e.index as number, thinking: d.thinking as string };
      return { type: 'noop' };
    }
    case 'content_block_stop':
      return { type: 'content_block_stop', index: e.index as number };
    case 'message_stop':
      return { type: 'message_stop' };
    default:
      return { type: 'noop' };
  }
}

export function clip(text: unknown): unknown {
  if (typeof text !== 'string' || text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} more characters not shown)`;
}

export function slimMessage(message: unknown): WireMessage {
  const m = rec(message);
  if (!message || typeof m.content === 'string') {
    return { role: m.role as string | undefined, content: clip(m.content) as string | undefined };
  }
  const content = ((m.content as unknown[]) || []).map((block): WireBlock => {
    const b = rec(block);
    if (b.type === 'tool_result') {
      const inner = Array.isArray(b.content)
        ? b.content.map((c: unknown) => {
            const cb = rec(c);
            return cb.type === 'text' ? { type: 'text', text: clip(cb.text) as string } : { type: cb.type as string };
          })
        : (clip(b.content) as string | undefined);
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id as string | undefined,
        is_error: Boolean(b.is_error),
        content: inner,
      };
    }
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking as string };
    if (b.type === 'image') return { type: 'image' };
    return block as WireBlock;
  });
  return { role: m.role as string | undefined, content };
}

export interface PermissionSuggestion {
  type: string;
  behavior?: string;
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  directories?: string[];
  mode?: string;
}

export function describeSuggestions(suggestions: PermissionSuggestion[]): string | null {
  const rules: string[] = [];
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

/** Exactly `String(err?.message || err)`, which this replaces across the old server. */
export function errorMessage(err: unknown): string {
  const message = err == null ? undefined : (err as { message?: unknown }).message;
  return String(message || err);
}

export function friendlyError(err: unknown): string {
  const msg = errorMessage(err);
  if (/Native CLI binary/.test(msg)) {
    return `${msg}\nThe Claude Code binary for this platform was not installed. Rebuild the add-on and check the build log for npm errors.`;
  }
  if (/exited with code/.test(msg)) {
    return `${msg}\nClaude Code stopped unexpectedly. The add-on log has the details.`;
  }
  return msg;
}
