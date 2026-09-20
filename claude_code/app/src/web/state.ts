// The panel's single mutable state object, plus the shapes it holds.
// Ported from public/app.js:41-57 (state), :59-66 (the `MODE_LABEL` entry at
// line 68 lives here too since it is state-adjacent, not a DOM ref).

import type {
  EvPermission,
  ModelOption,
  PermissionMode,
  PublicState,
  SessionListItem,
  SessionSummary,
} from '../shared/protocol';

export interface CurrentSession {
  kind: 'new' | 'disk' | 'live';
  liveId: string | null;
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  loading: boolean;
}

export interface DraftEntry {
  kind: 'text' | 'thinking';
  text: string;
  el: HTMLElement;
  stopped: boolean;
  dirty: boolean;
}

export interface ToolEntry {
  stateEl: HTMLElement;
  resultBox: HTMLElement;
  name: string;
}

export interface PendingStart {
  reqId: string;
  text: string;
  target: CurrentSession;
}

export interface AttachedImage {
  name: string;
  mediaType: string;
  url: string;
  data: string;
}

export interface AppState {
  config: PublicState | null;
  sessions: SessionListItem[];
  live: SessionSummary[];
  models: ModelOption[] | null;
  current: CurrentSession;
  lastSeq: number;
  pendingStart: PendingStart | null;
  draftMode: PermissionMode;
  draftModel: string;
  images: AttachedImage[];
  approvals: EvPermission[];
  tools: Map<string, ToolEntry>;
  drafts: Map<number, DraftEntry>;
  todosEl: HTMLElement | null;
  ws: WebSocket | null;
}

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
};

export const state: AppState = {
  config: null,
  sessions: [],
  live: [],
  models: null,
  // kind: 'new' | 'disk' | 'live'
  current: { kind: 'new', liveId: null, sessionId: null, cwd: null, title: null, loading: false },
  lastSeq: 0,
  pendingStart: null,
  draftMode: 'default',
  draftModel: '',
  images: [],
  approvals: [],
  tools: new Map(),
  drafts: new Map(),
  todosEl: null,
  ws: null,
};
