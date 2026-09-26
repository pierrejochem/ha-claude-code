// The contract between the add-on server and the browser panel. Both sides
// compile against this file, so an event the server records and a branch the
// panel renders cannot drift apart silently.
//
// This module must not import anything: the server resolves it through
// NodeNext and the browser through esbuild.

export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type PermissionMode = (typeof MODES)[number];

export type SessionStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'closed';

export interface Root {
  path: string;
  label: string;
}

export interface ModelOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionSummary {
  liveId: string;
  sessionId: string | null;
  cwd: string;
  model: string | null;
  mode: PermissionMode;
  title: string | null;
  status: SessionStatus;
  resumed: boolean;
  historyCount: number;
  pending: number;
  lastActivity: number;
}

export interface PublicState {
  version: string;
  authConfigured: boolean;
  roots: Root[];
  defaultCwd: string;
  defaultMode: PermissionMode;
  defaultModel: string;
  modes: readonly PermissionMode[];
  models: ModelOption[] | null;
  haApi: boolean;
}

// ------------------------------------------------------------ SDK messages
// The panel renders a narrowed shape, not the SDK's full message type. The
// server converts; see slimMessage in src/live-session.ts.

export interface WireTextBlock { type: 'text'; text: string }
export interface WireThinkingBlock { type: 'thinking'; thinking: string }
export interface WireToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface WireImageBlock { type: 'image' }
export interface WireToolResultBlock {
  type: 'tool_result';
  // Both of these pass straight through from the SDK block. A tool that
  // returned nothing, or a malformed block, leaves them undefined; the
  // mappers forward that rather than inventing a value.
  tool_use_id: string | undefined;
  is_error: boolean;
  content: string | Array<{ type: string; text?: string }> | undefined;
}
// Not exhaustive over the SDK's block kinds — see wire.ts's pass-through for
// the block kinds this union deliberately leaves uncovered.
export type WireBlock =
  | WireTextBlock
  | WireThinkingBlock
  | WireToolUseBlock
  | WireImageBlock
  | WireToolResultBlock;

export interface WireMessage {
  role: string | undefined;
  // `undefined` when the SDK handed us no message at all; slimMessage passes
  // that through rather than inventing an empty string.
  content: string | WireBlock[] | undefined;
}

export interface WireSdkMessage {
  type: 'assistant' | 'user';
  // Optional on the SDK's live user message; passed straight through rather
  // than invented. The panel carries it but does not read it.
  uuid: string | undefined;
  parent_tool_use_id: string | null;
  message: WireMessage;
}

// ---------------------------------------------------------- stream events
// Slimmed partial-message events. Usage blobs and signatures are dropped.

export type WireStreamEvent =
  | { type: 'message_start' }
  | { type: 'content_block_start'; index: number; block: { type?: string; name?: string } }
  | { type: 'content_block_delta'; index: number; text?: string; thinking?: string }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop' }
  | { type: 'noop' };

// --------------------------------------------------------- session events
// Everything the server records into a session's replayable log, plus the
// unlogged 'stream' event. Discriminated on `k`.

export interface EvUser { k: 'user'; text: string; images: number }
export interface EvInit {
  k: 'init';
  sessionId: string;
  model?: string;
  cwd?: string;
  // Whatever mode the CLI reports for itself, which is a wider set than this
  // add-on's own MODES. Recorded for the log; the panel does not read it.
  mode?: string;
}
export interface EvSdk { k: 'sdk'; m: WireSdkMessage }
export interface EvStream { k: 'stream'; event: WireStreamEvent }
export interface EvResult {
  k: 'result';
  subtype: string;
  isError: boolean;
  text: string | null;
  durationMs?: number;
  turns?: number;
  costUsd?: number;
}
export interface EvPermission {
  k: 'permission';
  requestId: string;
  toolName: string;
  input: unknown;
  title: string | null;
  description: string | null;
  reason: string | null;
  blockedPath: string | null;
  canAlways: boolean;
  alwaysLabel: string | null;
  subagent: boolean;
}
export interface EvPermissionResolved {
  k: 'permission_resolved';
  requestId: string;
  behavior: string;
}
export interface EvMode { k: 'mode'; mode: PermissionMode }
export interface EvCompact { k: 'compact' }
export interface EvClosed { k: 'closed'; reason: string }
export interface EvError { k: 'error'; message: string }

export type SessionEvent =
  | EvUser
  | EvInit
  | EvSdk
  | EvStream
  | EvResult
  | EvPermission
  | EvPermissionResolved
  | EvMode
  | EvCompact
  | EvClosed
  | EvError;

/** An entry in a session's replayable log. `stream` events are never logged. */
export interface LogEntry {
  seq: number;
  ev: SessionEvent;
}

// ------------------------------------------------------------- permissions

export interface PermissionDecision {
  behavior: 'allow' | 'always' | 'deny';
  message?: string;
  answers?: Record<string, string>;
}

export interface ImageAttachment {
  mediaType: string;
  data: string;
}

// ------------------------------------------------------- client -> server

export interface MsgStart {
  type: 'start';
  reqId?: string;
  text?: string;
  images?: ImageAttachment[];
  cwd?: string;
  mode?: string;
  model?: string;
  resume?: string;
}
export interface MsgSend {
  type: 'send';
  liveId: string;
  text?: string;
  images?: ImageAttachment[];
}
export interface MsgAttach { type: 'attach'; liveId: string; since?: number }
export interface MsgInterrupt { type: 'interrupt'; liveId: string }
export interface MsgPermission {
  type: 'permission';
  // Null when the session closed or was evicted while its card was still on
  // screen: the panel still sends the answer and the server's `need()` reports
  // the session is gone, which is what the user sees.
  liveId: string | null;
  requestId: string;
  decision?: PermissionDecision;
}
export interface MsgSetMode { type: 'set_mode'; liveId: string; mode: string }
export interface MsgSetModel { type: 'set_model'; liveId: string; model: string }
export interface MsgClose { type: 'close'; liveId: string }

export type ClientMessage =
  | MsgStart
  | MsgSend
  | MsgAttach
  | MsgInterrupt
  | MsgPermission
  | MsgSetMode
  | MsgSetModel
  | MsgClose;

// ------------------------------------------------------- server -> client

export interface SrvHello { type: 'hello'; state: PublicState; live: SessionSummary[] }
export interface SrvStarted { type: 'started'; reqId?: string; session: SessionSummary }
export interface SrvReplay {
  type: 'replay';
  liveId: string;
  session: SessionSummary;
  entries: LogEntry[];
}
/** `seq` is null for stream events, which are broadcast but never logged. */
export interface SrvEvent {
  type: 'event';
  liveId: string;
  seq: number | null;
  ev: SessionEvent;
}
export interface SrvLive { type: 'live'; live: SessionSummary[] }
export interface SrvModels { type: 'models'; models: ModelOption[] }
export interface SrvError {
  type: 'error';
  reqId: string | null;
  liveId: string | null;
  message: string;
}

export type ServerMessage =
  | SrvHello
  | SrvStarted
  | SrvReplay
  | SrvEvent
  | SrvLive
  | SrvModels
  | SrvError;

// --------------------------------------------------------------- REST API

export interface SessionListItem {
  sessionId: string;
  title: string;
  cwd: string | null;
  lastModified: number;
  /**
   * False when the session's folder is outside the roots this add-on can
   * reach, which a session borrowed from another Claude config folder often
   * is. The panel still opens its transcript; the server refuses to resume it.
   */
  reachable: boolean;
}

export interface SessionDetail {
  info: { sessionId: string; title: string | undefined; cwd: string | null } | null;
  messages: WireSdkMessage[];
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}
