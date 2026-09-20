// The session sidebar: list rendering, grouping by recency, and the session
// loader. Ported from public/app.js:581-620.

import type { SessionSummary } from '../shared/protocol';
import { el } from './dom';
import { refs } from './refs';
import { state } from './state';
import { getSessions } from './api';

export interface SidebarItem {
  sessionId: string | null;
  title: string;
  cwd: string | null;
  lastModified: number;
  live?: SessionSummary;
}

// `renderSidebar`'s session buttons call `openSession`, which lives in
// `main.ts` (Task 17). Importing it here would create a cycle, so this
// module takes the handler once at startup instead.
let onOpen: (item: SidebarItem) => void = () => {};

export function initSidebar(handler: (item: SidebarItem) => void): void {
  onOpen = handler;
}

export function liveFor(sessionId: string | null): SessionSummary | undefined {
  return sessionId ? state.live.find((l) => l.sessionId === sessionId) : undefined;
}

export function currentLive(): SessionSummary | undefined {
  return state.current.liveId ? state.live.find((l) => l.liveId === state.current.liveId) : undefined;
}

export function renderSidebar(): void {
  const items: SidebarItem[] = state.sessions.map((s) => ({ ...s, live: liveFor(s.sessionId) }));
  for (const l of state.live) {
    if (!items.some((i) => i.live === l)) items.unshift({ sessionId: l.sessionId, title: l.title || 'New session', cwd: l.cwd, lastModified: l.lastActivity, live: l });
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
    for (const s of bucket) {
      const active = (s.live && s.live.liveId === state.current.liveId) || (s.sessionId && s.sessionId === state.current.sessionId);
      const status = s.live?.status;
      refs.list.append(el('button', {
        class: 'session', type: 'button', 'aria-current': active ? 'true' : null, title: s.cwd || null,
        onclick: () => onOpen(s),
      },
      el('span', { class: 'session-title', text: s.title }),
      el('span', { class: 'session-dot ' + (status === 'running' || status === 'starting' ? 'running' : status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : ''),
        title: status === 'waiting' ? 'Waiting for your approval' : status === 'running' ? 'Working' : null })));
    }
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
