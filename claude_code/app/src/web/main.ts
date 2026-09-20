// The panel's entry point: event routing, session navigation, the server
// message dispatcher, and the wiring that connects every module together.
// Ported from public/app.js:455-496 (applyEvent), :623-660 (newSession,
// openSession), :858-918 (onServer) and :920-968 (wiring).

import type { ServerMessage, SessionEvent } from '../shared/protocol';
import { isPermissionMode } from '../shared/protocol';
import { $, el } from './dom';
import { refs } from './refs';
import { state } from './state';
import { place, stick } from './scroll';
import { toast, closeNav, applyTheme } from './shell';
import { connect, sendWs } from './socket';
import { md } from './markdown';
import {
  addUser,
  addDivider,
  addNotice,
  applySdkMessage,
  applyStream,
  clearAllDrafts,
  resetTranscript,
  settleOpenTools,
} from './transcript';
import { renderApprovals } from './approvals';
import { renderHeader, renderWelcome } from './header';
import {
  autosize,
  addFiles,
  fillSelects,
  initComposer,
  submit,
  syncControls,
} from './composer';
import { initFolderPicker, openFolderPicker } from './folder-picker';
import {
  currentLive,
  initSidebar,
  liveFor,
  loadSessions,
  renderSidebar,
  type SidebarItem,
} from './sidebar';
import { getSession } from './api';

// ------------------------------------------------------------ navigation
function applyEvent(ev: SessionEvent): void {
  switch (ev.k) {
    case 'stream':
      return applyStream(ev.event);
    case 'user':
      return addUser(ev.text, ev.images);
    case 'sdk':
      return applySdkMessage(ev.m, false);
    case 'init':
      state.current.sessionId = ev.sessionId;
      if (ev.cwd) state.current.cwd = ev.cwd;
      return renderHeader();
    case 'mode':
      refs.mode.value = ev.mode;
      return;
    case 'compact':
      return addDivider('Earlier conversation summarised to free up context');
    case 'permission':
      state.approvals.push(ev);
      return renderApprovals();
    case 'permission_resolved':
      state.approvals = state.approvals.filter((a) => a.requestId !== ev.requestId);
      return renderApprovals();
    case 'result': {
      clearAllDrafts();
      settleOpenTools();
      // Claude Code usually says the error itself as its last message; don't repeat it.
      const lastProse = [...refs.transcript.querySelectorAll('.prose')].pop()?.textContent?.trim();
      if (ev.isError && (!ev.text || ev.text.trim() !== lastProse)) addNotice(ev.text || 'Claude stopped with an error.', true);
      else if (ev.subtype && ev.subtype !== 'success') addNotice(`Claude stopped early (${ev.subtype.replace(/_/g, ' ')}).`, false);
      const bits: string[] = [];
      if (ev.durationMs) bits.push(ev.durationMs < 90000 ? `${Math.max(1, Math.round(ev.durationMs / 1000))}s` : `${Math.round(ev.durationMs / 60000)} min`);
      // `ev.turns` / `ev.costUsd` are optional on `EvResult`; `?? 0` keeps the
      // same false result an untyped `undefined > 1` / `undefined > 0.005`
      // comparison produced in app.js, without comparing `undefined` itself.
      if ((ev.turns ?? 0) > 1) bits.push(`${ev.turns} steps`);
      if ((ev.costUsd ?? 0) > 0.005) bits.push(`≈ $${(ev.costUsd ?? 0).toFixed(2)} at API rates`);
      if (bits.length) place(el('div', { class: 'turn-meta', text: bits.join(', ') }));
      loadSessions();
      return;
    }
    case 'error':
      clearAllDrafts();
      settleOpenTools();
      return addNotice(ev.message, true);
    case 'closed':
      clearAllDrafts();
      settleOpenTools();
      if (state.current.kind === 'live') {
        state.current = { ...state.current, kind: state.current.sessionId ? 'disk' : 'new', liveId: null };
        if (ev.reason === 'idle' || ev.reason === 'evicted') addDivider('Session paused. Your next message resumes it.');
      }
      return syncControls();
    default:
      return;
  }
}

function newSession(): void {
  state.current = { kind: 'new', liveId: null, sessionId: null, cwd: state.config?.defaultCwd || null, title: null, loading: false };
  state.lastSeq = 0;
  resetTranscript();
  renderApprovals();
  renderWelcome();
  renderHeader();
  syncControls();
  renderSidebar();
  closeNav();
  refs.input.focus();
}

async function openSession(s: SidebarItem): Promise<void> {
  closeNav();
  const liveEntry = s.live || liveFor(s.sessionId);
  state.current = { kind: liveEntry ? 'live' : 'disk', liveId: liveEntry?.liveId || null, sessionId: s.sessionId, cwd: s.cwd, title: s.title, loading: true };
  state.lastSeq = 0;
  resetTranscript();
  renderApprovals();
  refs.welcome.hidden = true;
  renderHeader();
  syncControls();
  renderSidebar();

  const opening = state.current;
  try {
    // For a resumed session the live log only holds what happened since the
    // resume, so the earlier part comes from disk, capped where the log
    // starts. `s.sessionId` is checked directly (rather than through an
    // intermediate boolean, as app.js:645 did with `needHistory`) so it
    // narrows from `string | null` to `string` for the `getSession()` call
    // below without an assertion; the three conditions are the same ones
    // ANDed together, just inline.
    if (s.sessionId && (!liveEntry || liveEntry.resumed) && !(liveEntry && liveEntry.historyCount === 0)) {
      const data = await getSession(s.sessionId, liveEntry?.historyCount);
      if (state.current !== opening) return;
      for (const m of data.messages) applySdkMessage(m, true);
      settleOpenTools();
    }
    if (liveEntry) sendWs({ type: 'attach', liveId: liveEntry.liveId, since: 0 });
    else opening.loading = false;
  } catch (err) {
    opening.loading = false;
    addNotice(`Could not load this session: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  stick(true);
}

// -------------------------------------------------------------- server
function onServer(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hello': {
      const first = !state.config;
      state.config = msg.state;
      state.live = msg.live;
      state.models = msg.state.models || state.models;
      refs.conn.className = 'conn ok';
      refs.connText.textContent = `Connected, v${msg.state.version}`;
      refs.fineprint.hidden = !msg.state.authConfigured;
      fillSelects();
      if (first) {
        state.draftMode = msg.state.defaultMode;
        newSession();
        loadSessions();
      } else if (state.current.kind === 'live') {
        // Reconnected: catch up on what was missed, or fall back to the
        // saved copy. `currentLive()` only ever matches when
        // `state.current.liveId` is truthy (see sidebar.ts), so the extra
        // `state.current.liveId &&` here gives the type checker the same
        // guarantee `MsgAttach.liveId: string` needs without asserting it -
        // it never changes which branch runs (same pattern as
        // composer.ts's `submit()`).
        if (state.current.liveId && currentLive()) sendWs({ type: 'attach', liveId: state.current.liveId, since: state.lastSeq });
        else state.current = { ...state.current, kind: state.current.sessionId ? 'disk' : 'new', liveId: null };
      }
      renderSidebar();
      syncControls();
      return;
    }
    case 'live':
      state.live = msg.live;
      renderSidebar();
      renderHeader();
      syncControls();
      return;
    case 'models':
      state.models = msg.models;
      fillSelects();
      syncControls();
      return;
    case 'started': {
      const p = state.pendingStart;
      if (!p || p.reqId !== msg.reqId) return;
      state.pendingStart = null;
      if (state.current !== p.target) return;
      if (!state.live.some((l) => l.liveId === msg.session.liveId)) state.live.push(msg.session);
      state.current = { ...state.current, kind: 'live', liveId: msg.session.liveId, sessionId: msg.session.sessionId, cwd: msg.session.cwd, loading: false };
      state.lastSeq = 0;
      renderHeader();
      renderSidebar();
      syncControls();
      return;
    }
    case 'replay':
      if (msg.liveId !== state.current.liveId) return;
      for (const entry of msg.entries) {
        if (entry.seq > state.lastSeq) {
          state.lastSeq = entry.seq;
          applyEvent(entry.ev);
        }
      }
      state.current.loading = false;
      syncControls();
      stick(true);
      return;
    case 'event':
      if (msg.liveId !== state.current.liveId || state.current.loading) return;
      if (msg.seq != null) {
        if (msg.seq <= state.lastSeq) return;
        state.lastSeq = msg.seq;
      }
      applyEvent(msg.ev);
      return;
    case 'error': {
      const p = state.pendingStart;
      if (p && p.reqId === msg.reqId) {
        state.pendingStart = null;
        if (!refs.input.value) {
          refs.input.value = p.text;
          autosize();
        }
        if (state.current.kind === 'new' && !refs.transcript.childElementCount) refs.welcome.hidden = false;
      }
      toast(msg.message);
      syncControls();
      return;
    }
    default:
      return;
  }
}

// ----------------------------------------------------------------- wiring
initSidebar(openSession);
initComposer(renderHeader);
initFolderPicker(renderHeader);

refs.input.addEventListener('input', () => {
  autosize();
  syncControls();
});
refs.input.addEventListener('keydown', (e) => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) {
    e.preventDefault();
    submit();
  }
});
refs.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
refs.send.addEventListener('click', submit);
refs.stop.addEventListener('click', () => {
  // The stop button is only shown while a live session is busy (see
  // composer.ts's `syncControls()`), which implies `state.current.liveId`
  // is set; the guard gives the type checker that same guarantee for
  // `MsgInterrupt.liveId: string` without asserting it.
  if (state.current.liveId) sendWs({ type: 'interrupt', liveId: state.current.liveId });
});
$('attachBtn').addEventListener('click', () => refs.file.click());
refs.file.addEventListener('change', () => {
  addFiles(refs.file.files ?? []);
  refs.file.value = '';
});
$('composer').addEventListener('dragover', (e) => e.preventDefault());
$('composer').addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...(e.dataTransfer?.files ?? [])]);
});

refs.mode.addEventListener('change', () => {
  // Same liveId-narrowing pattern as the stop button, above.
  if (state.current.liveId && currentLive()) sendWs({ type: 'set_mode', liveId: state.current.liveId, mode: refs.mode.value });
  else if (isPermissionMode(refs.mode.value)) state.draftMode = refs.mode.value;
});
refs.model.addEventListener('change', () => {
  if (state.current.liveId && currentLive()) sendWs({ type: 'set_model', liveId: state.current.liveId, model: refs.model.value });
  state.draftModel = refs.model.value;
});

$('newSession').addEventListener('click', newSession);
$('openSidebar').addEventListener('click', () => refs.app.classList.add('nav-open'));
$('closeSidebar').addEventListener('click', closeNav);
$('scrim').addEventListener('click', closeNav);
refs.folderChip.addEventListener('click', (e) => {
  e.stopPropagation();
  refs.popover.hidden ? openFolderPicker(null) : (refs.popover.hidden = true);
});
document.addEventListener('click', (e) => {
  if (!refs.popover.hidden && !(e.target instanceof Node && refs.popover.contains(e.target))) refs.popover.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    refs.popover.hidden = true;
    closeNav();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    newSession();
  }
});

$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme')
    ? document.documentElement.getAttribute('data-theme') === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('cc-theme', next);
  } catch {
    /* private mode */
  }
});
try {
  applyTheme(localStorage.getItem('cc-theme'));
} catch {
  /* private mode */
}

declare global {
  interface Window {
    __panel?: Record<string, unknown>;
  }
}
window.__panel = { md, applyEvent, applySdkMessage, onServer, state };
connect(onServer, (status) => {
  if (status === 'connecting') {
    refs.conn.className = 'conn';
    refs.connText.textContent = 'Connecting';
  } else if (status === 'down') {
    refs.conn.className = 'conn down';
    refs.connText.textContent = 'Reconnecting';
    syncControls();
  }
});
