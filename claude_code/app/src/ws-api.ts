// The WebSocket layer: connection handling, the client-message dispatch
// switch, the keep-alive ping, and the broadcast fan-out. Ported from
// server.js:285-380 (the WebSocketServer construction, the upgrade handler,
// the connection handler, `need`, `sanitizeImages`, and the ping interval)
// plus `broadcast` from server.js:114-117, which moves here because it owns
// the client set.
//
// This module holds no state of its own beyond what a single call to
// createWsApi sets up: the live-session registry lives in server.ts, which
// passes it in as WsDeps.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { LiveSession } from './live-session.js';
import { errorMessage } from './wire.js';
import { isPermissionMode } from './shared/protocol.js';
import type {
  ClientMessage,
  MsgStart,
  ServerMessage,
  ImageAttachment,
  PublicState,
  SessionSummary,
} from './shared/protocol.js';

export interface WsDeps {
  publicState: () => PublicState;
  liveList: () => SessionSummary[];
  need: (liveId: string) => LiveSession;
  startSession: (msg: MsgStart) => Promise<LiveSession>;
  get: (liveId: string) => LiveSession | undefined;
}

const CLIENT_MESSAGE_TYPES: ReadonlySet<ClientMessage['type']> = new Set([
  'start',
  'send',
  'attach',
  'interrupt',
  'permission',
  'set_mode',
  'set_model',
  'close',
]);

/**
 * Parses a raw WebSocket message. An unparseable payload, or one whose
 * `type` is not one of the eight known client message types, returns null —
 * reproducing today's silent `return` on bad input rather than throwing or
 * replying with an error.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== 'string' || !CLIENT_MESSAGE_TYPES.has(type as ClientMessage['type'])) return null;
  return value as ClientMessage;
}

function isSupportedImage(i: unknown): i is { mediaType: string; data: string } {
  const obj = i && typeof i === 'object' ? (i as Record<string, unknown>) : undefined;
  return /^image\/(png|jpeg|gif|webp)$/.test(String(obj?.mediaType)) && typeof obj?.data === 'string';
}

/** The guard on what base64 payload reaches the Agent SDK. */
export function sanitizeImages(images: unknown): ImageAttachment[] {
  if (!Array.isArray(images)) return [];
  return (images as unknown[])
    .filter(isSupportedImage)
    .slice(0, 6)
    .map((i) => ({ mediaType: i.mediaType, data: i.data }));
}

export function createWsApi(deps: WsDeps): {
  wss: WebSocketServer;
  broadcast: (payload: ServerMessage) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  shutdown: () => void;
} {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  // ws.isAlive does not move onto the socket object (that would mean lying
  // about a library type under strict); the ping sweep reads/writes this map
  // instead. Entries are removed whenever their socket leaves `clients`.
  const alive = new Map<WebSocket, boolean>();

  function broadcast(payload: ServerMessage): void {
    const data = JSON.stringify(payload);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  function drop(ws: WebSocket): void {
    clients.delete(ws);
    alive.delete(ws);
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => drop(ws));
    ws.on('error', () => drop(ws));
    ws.send(JSON.stringify({ type: 'hello', state: deps.publicState(), live: deps.liveList() } satisfies ServerMessage));

    ws.on('message', async (raw) => {
      const msg = parseClientMessage(raw.toString());
      if (!msg) return;

      const reply = (payload: ServerMessage): void => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
      };

      try {
        switch (msg.type) {
          case 'start': {
            const session = await deps.startSession(msg);
            reply({ type: 'started', reqId: msg.reqId, session: session.summary() });
            session.send(msg.text || '', sanitizeImages(msg.images));
            break;
          }
          case 'send':
            deps.need(msg.liveId).send(msg.text || '', sanitizeImages(msg.images));
            break;
          case 'attach': {
            const session = deps.need(msg.liveId);
            reply({
              type: 'replay',
              liveId: session.liveId,
              session: session.summary(),
              entries: session.replaySince(msg.since || 0),
            });
            break;
          }
          case 'interrupt':
            await deps.need(msg.liveId).interrupt();
            break;
          case 'permission':
            deps.need(msg.liveId).answerPermission(msg.requestId, msg.decision || { behavior: 'deny' });
            break;
          case 'set_mode':
            if (!isPermissionMode(msg.mode)) throw new Error('Unknown permission mode.');
            await deps.need(msg.liveId).setMode(msg.mode);
            break;
          case 'set_model':
            await deps.need(msg.liveId).setModel(msg.model);
            break;
          case 'close':
            deps.get(msg.liveId)?.close('user');
            break;
        }
      } catch (err) {
        reply({
          type: 'error',
          reqId: ('reqId' in msg && msg.reqId) || null,
          liveId: ('liveId' in msg && msg.liveId) || null,
          message: errorMessage(err),
        });
      }
    });
  });

  // Deliberately omits the remoteAllowed/pathname gate: this module has no
  // access to DEV/INGRESS_PROXY. Callers (server.ts) must check those and
  // destroy the socket themselves before calling this.
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  // Ingress and mobile browsers drop silent sockets; ping keeps them open and
  // clears out the ones that are gone.
  const pingInterval = setInterval(() => {
    for (const ws of clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        drop(ws);
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 25_000);
  pingInterval.unref();

  function shutdown(): void {
    clearInterval(pingInterval);
  }

  return { wss, broadcast, handleUpgrade, shutdown };
}
