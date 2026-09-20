// Transcript rendering: tool rows, prose/thought blocks, streaming drafts,
// and the SDK-message / stream-event entry points that turn wire protocol
// messages into DOM. Ported from public/app.js:280-322, 339-453.

import { el, icon, ICON } from './dom';
import { refs } from './refs';
import { state } from './state';
import { place, stick, markStick } from './scroll';
import { md, codeBlock } from './markdown';
import { describeTool, toolInputView, resultText, asToolInput } from './tools';
import type { TodoItem } from './tools';
import type { WireBlock, WireSdkMessage, WireStreamEvent, WireToolUseBlock } from '../shared/protocol';

// ------------------------------------------------------------- tool rows
export function addToolRow(block: WireToolUseBlock, before?: Node | null): void {
  const input = asToolInput(block.input);
  const [verb, target] = describeTool(block.name, input);
  const stateEl = el('span', { class: 'row-state busy' });
  const resultBox = el('div');
  const row = el(
    'details',
    { class: 'row tool' },
    el(
      'summary',
      null,
      icon(ICON.chev, 'chev'),
      el('span', { class: 'row-label' }, el('b', { text: verb }), target ? ' ' : null, target ? el('span', { text: target }) : null),
      stateEl,
    ),
    el('div', { class: 'row-body' }, toolInputView(block.name, input), resultBox),
  );
  place(row, before);
  state.tools.set(block.id, { stateEl, resultBox, name: block.name });
}

export function settleTool(id: string, content: unknown, isError: boolean): void {
  const t = state.tools.get(id);
  if (!t) return;
  t.stateEl.className = 'row-state ' + (isError ? 'err' : 'ok');
  t.stateEl.replaceChildren(icon(isError ? ICON.cross : ICON.check));
  const text = resultText(content).trim();
  // Precedence here is load-bearing and copied character for character from
  // app.js:304 (port fidelity governs; do not add clarifying parentheses).
  if ((text && !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(t.name)) || (text && isError)) {
    t.resultBox.replaceChildren(
      el('div', { class: 'label', text: isError ? 'Error' : 'Result' }),
      codeBlock(text, isError ? 'error' : 'output'),
    );
  }
}

export function settleOpenTools(): void {
  for (const t of state.tools.values()) {
    if (t.stateEl.classList.contains('busy')) t.stateEl.className = 'row-state';
  }
}

export function renderTodos(todos: TodoItem[] | undefined, before?: Node | null): void {
  state.todosEl?.remove();
  const list = el(
    'ul',
    { class: 'todos', 'aria-label': 'Claude’s to-do list' },
    (todos || []).map((t) => el('li', { class: t.status, text: t.status === 'in_progress' ? t.activeForm || t.content : t.content })),
  );
  state.todosEl = list;
  place(list, before);
}

// ------------------------------------------------------------ transcript
export function resetTranscript(): void {
  refs.transcript.replaceChildren();
  state.tools.clear();
  state.drafts.clear();
  state.todosEl = null;
  state.approvals = [];
  // app.js:345 called renderApprovals() here. That function lives in
  // approvals.ts (Task 14), which imports from this module, so calling it
  // here would create a cycle. main.ts calls renderApprovals() immediately
  // after each resetTranscript() call instead - the two call sites are
  // newSession (app.js:626) and openSession (app.js:637).
}

export function addUser(text: string, imageCount: number): void {
  const bubble = el('div', { class: 'bubble' });
  if (imageCount) {
    bubble.append(
      el('span', { class: 'img-note', text: imageCount === 1 ? '1 image attached' : `${imageCount} images attached` }),
    );
  }
  bubble.append(text || '');
  place(el('div', { class: 'turn-user' }, bubble));
  stick(true);
}

export function addProse(text: string | undefined, before?: Node | null): void {
  if (!text || !text.trim()) return;
  place(el('div', { class: 'prose' }, md(text)), before);
}

export function addThought(text: string | undefined, before?: Node | null): void {
  if (!text || !text.trim()) return;
  place(
    el(
      'details',
      { class: 'row' },
      el('summary', null, icon(ICON.chev, 'chev'), el('span', { class: 'row-label', text: 'Thought process' })),
      el('div', { class: 'row-body' }, el('div', { class: 'thought', text: text.trim() })),
    ),
    before,
  );
}

export function addNotice(text: string, isErr?: boolean): void {
  place(el('div', { class: 'notice' + (isErr ? ' err' : ''), text }));
}
export function addDivider(text: string): void {
  place(el('div', { class: 'divider', text }));
}

const META_USER = /^\s*(<[a-z-]+>|Caveat: The messages below|\[Request interrupted)/i;

/** Renders one SDK-shaped message. `history` = loaded from disk rather than streamed. */
export function applySdkMessage(m: WireSdkMessage, history: boolean): void {
  if (m.parent_tool_use_id) return;
  const content = m.message?.content;

  if (m.type === 'assistant') {
    const anchor = firstActiveDraft();
    clearStoppedDrafts();
    // Array.isArray fallback kept from app.js:379-381. `content`, when not
    // an array, is `string | undefined` per WireMessage; the fallback
    // block's `text` is typed to match rather than widened to `string`.
    const blocks: Array<WireBlock | { type: 'text'; text: string | undefined }> = Array.isArray(content)
      ? content
      : [{ type: 'text', text: content }];
    for (const block of blocks) {
      if (block.type === 'text') addProse(block.text, anchor);
      else if (block.type === 'thinking') addThought(block.thinking, anchor);
      else if (block.type === 'tool_use') {
        if (block.name === 'TodoWrite') renderTodos(asToolInput(block.input).todos, anchor);
        else addToolRow(block, anchor);
      }
    }
    return;
  }

  if (m.type === 'user') {
    if (typeof content === 'string') {
      if (history && !META_USER.test(content)) addUser(content, 0);
      return;
    }
    let text = '';
    let images = 0;
    for (const block of content || []) {
      if (block.type === 'tool_result') {
        // WireToolResultBlock.tool_use_id admits undefined (the mapper
        // forwards an absent id rather than inventing one); such a block
        // can never match an entry in state.tools, so it is skipped here
        // exactly as it would silently no-op through settleTool's own
        // `if (!t) return;` in the untyped original.
        if (block.tool_use_id) settleTool(block.tool_use_id, block.content, block.is_error);
      } else if (block.type === 'text') text += (text ? '\n' : '') + block.text;
      else if (block.type === 'image') images++;
    }
    if (history && (text || images) && !META_USER.test(text)) addUser(text, images);
  }
}

// Streaming drafts: text appears token by token, then the finished
// assistant message replaces the draft in the same place.
function firstActiveDraft(): Node | null {
  for (const d of state.drafts.values()) if (!d.stopped && d.el.parentNode) return d.el;
  return null;
}
function clearStoppedDrafts(): void {
  for (const [k, d] of state.drafts)
    if (d.stopped) {
      d.el.remove();
      state.drafts.delete(k);
    }
}
export function clearAllDrafts(): void {
  for (const d of state.drafts.values()) d.el.remove();
  state.drafts.clear();
}

export function applyStream(ev: WireStreamEvent): void {
  if (ev.type === 'message_start') return clearAllDrafts();
  if (ev.type === 'content_block_start') {
    if (ev.block.type === 'text') {
      const node = el('div', { class: 'prose draft' });
      state.drafts.set(ev.index, { kind: 'text', text: '', el: node, stopped: false, dirty: false });
      place(node);
    } else if (ev.block.type === 'thinking') {
      const node = el(
        'div',
        { class: 'row' },
        el('div', { class: 'row-head' }, el('span', { class: 'row-label', text: 'Thinking' }), el('span', { class: 'row-state busy' })),
      );
      // DraftEntry.dirty is required (state.ts), unlike app.js:430's
      // thinking-draft literal which omitted it; added here to satisfy the
      // type. Only text-kind drafts ever read `.dirty`, so this is inert.
      state.drafts.set(ev.index, { kind: 'thinking', text: '', el: node, stopped: false, dirty: false });
      place(node);
    }
    return;
  }
  // 'message_stop' and 'noop' carry no `index`. In the untyped original
  // `ev.index` was simply undefined for them and the Map lookup below found
  // nothing; WireStreamEvent's narrowing makes that case explicit instead
  // of letting `ev.index` be read off a variant that lacks it.
  if (ev.type !== 'content_block_delta' && ev.type !== 'content_block_stop') return;
  const d = state.drafts.get(ev.index);
  if (!d) return;
  if (ev.type === 'content_block_delta' && d.kind === 'text' && ev.text) {
    d.text += ev.text;
    if (!d.dirty) {
      d.dirty = true;
      requestAnimationFrame(() => {
        d.dirty = false;
        if (!d.el.parentNode) return;
        markStick();
        d.el.replaceChildren(md(d.text));
        stick();
      });
    }
  } else if (ev.type === 'content_block_stop') {
    d.stopped = true;
    d.el.classList.remove('draft');
  }
}
