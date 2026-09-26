// The session sidebar: list rendering, grouping by recency, the delete
// affordance, and the session loader. Ported from public/app.js:581-620.

import type { SessionSummary } from '../shared/protocol';
import { el, icon, ICON } from './dom';
import { refs } from './refs';
import { state } from './state';
import { deleteSession, getSessions } from './api';
import { toast } from './shell';

export interface SidebarItem {
  sessionId: string | null;
  title: string;
  cwd: string | null;
  lastModified: number;
  /** False for a session whose folder this add-on cannot reach; see SessionListItem. */
  reachable?: boolean;
  live?: SessionSummary;
}

// `renderSidebar`'s session buttons call `openSession`, which lives in
// `main.ts` (Task 17). Importing it here would create a cycle, so this
// module takes the handler once at startup instead.
let onOpen: (item: SidebarItem) => void = () => {};
// Called after a delete went through, so `main.ts` can leave a session that is
// no longer there.
let onDeleted: (sessionId: string) => void = () => {};

export function initSidebar(handler: (item: SidebarItem) => void, deleted: (sessionId: string) => void): void {
  onOpen = handler;
  onDeleted = deleted;
}

// The session whose row is asking "Delete this session?" instead of showing its
// title. Deleting a transcript cannot be undone, so it always takes two
// clicks; a row rather than a dialog keeps the question next to what it is
// about, and ingress panels are an iframe where `confirm()` may not open.
let confirming: string | null = null;

/**
 * Drops a pending delete question. Returns whether there was one, so a caller
 * that re-renders the sidebar anyway can skip doing it twice.
 */
export function clearDeleteConfirm(): boolean {
  const had = confirming !== null;
  confirming = null;
  return had;
}

export function liveFor(sessionId: string | null): SessionSummary | undefined {
  return sessionId ? state.live.find((l) => l.sessionId === sessionId) : undefined;
}

export function currentLive(): SessionSummary | undefined {
  return state.current.liveId ? state.live.find((l) => l.liveId === state.current.liveId) : undefined;
}

function sessionRow(s: SidebarItem): HTMLElement {
  const active = (s.live && s.live.liveId === state.current.liveId) || (s.sessionId && s.sessionId === state.current.sessionId);
  const status = s.live?.status;
  const outOfReach = s.reachable === false;
  // A session with no id of its own has not been written to disk yet: it is a
  // brand-new live session waiting for its first init event, so there is
  // nothing to delete and nothing to confirm against.
  const sessionId = s.sessionId;
  if (sessionId && sessionId === confirming) return confirmRow(sessionId);

  const row = el('div', { class: 'session' + (outOfReach ? ' out-of-reach' : ''), 'aria-current': active ? 'true' : null },
    el('button', {
      class: 'session-open', type: 'button',
      title: outOfReach ? `${s.cwd} - read-only, outside the folders this add-on can reach` : s.cwd || null,
      onclick: () => onOpen(s),
    },
    el('span', { class: 'session-title', text: s.title }),
    el('span', { class: 'session-dot ' + (status === 'running' || status === 'starting' ? 'running' : status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : ''),
      title: status === 'waiting' ? 'Waiting for your approval' : status === 'running' ? 'Working' : null })));

  if (sessionId) {
    row.append(el('button', {
      class: 'session-del', type: 'button', title: 'Delete this session', 'aria-label': `Delete ${s.title}`,
      onclick: () => {
        confirming = sessionId;
        renderSidebar();
      },
    }, icon(ICON.trash)));
  }
  return row;
}

function confirmRow(sessionId: string): HTMLElement {
  return el('div', { class: 'session confirming' },
    el('span', { class: 'session-title', text: 'Delete this session?' }),
    el('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: () => void remove(sessionId) }),
    el('button', {
      class: 'btn small', type: 'button', text: 'Keep',
      onclick: () => {
        confirming = null;
        renderSidebar();
      },
    }));
}

async function remove(sessionId: string): Promise<void> {
  confirming = null;
  // Re-rendered before the request, so a second click cannot land on the
  // confirm button while it is in flight.
  renderSidebar();
  try {
    await deleteSession(sessionId);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return;
  }
  state.sessions = state.sessions.filter((x) => x.sessionId !== sessionId);
  state.live = state.live.filter((l) => l.sessionId !== sessionId);
  renderSidebar();
  onDeleted(sessionId);
  // The server closes a live copy of the session as it deletes it, so the list
  // is refetched rather than trusted: what is left may differ from this guess.
  void loadSessions();
}

export function renderSidebar(): void {
  const items: SidebarItem[] = state.sessions.map((s) => ({ ...s, live: liveFor(s.sessionId) }));
  for (const l of state.live) {
    // A running session started in a folder this add-on can reach, by
    // construction: startSession refuses any other.
    if (!items.some((i) => i.live === l)) items.unshift({ sessionId: l.sessionId, title: l.title || 'New session', cwd: l.cwd, lastModified: l.lastActivity, reachable: true, live: l });
  }
  const day = 86400000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  const groups: Array<[string, number]> = [['Today', midnight], ['Yesterday', midnight - day], ['Previous 7 days', midnight - 7 * day], ['Older', -Infinity]];
  refs.list.replaceChildren();
  if (!items.length) {
    refs.list.append(el('p', { class: 'session-empty', text: 'Sessions you start show up here, and stay after a restart.' }));
    return;
  }
  let cursor = 0;
  items.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  for (const [label, from] of groups) {
    const bucket: SidebarItem[] = [];
    while (cursor < items.length && (items[cursor].lastModified || 0) >= from) bucket.push(items[cursor++]);
    if (!bucket.length) continue;
    refs.list.append(el('div', { class: 'group-label', text: label }));
    for (const s of bucket) refs.list.append(sessionRow(s));
  }
}

export async function loadSessions(): Promise<void> {
  try {
    state.sessions = await getSessions();
    renderSidebar();
  } catch {
    /* sidebar keeps its last state */
  }
}
