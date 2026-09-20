// The process entry point: wires the options, live-session registry,
// REST routes and WebSocket layer built by the earlier porting tasks into
// one HTTP(S) server. Ported from server.js:1-12, 108-192, 201-213,
// 259-281, 286-293, 382-394.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { LiveSession } from './live-session.js';
import { handleApi, sendJson } from './http-api.js';
import { createWsApi } from './ws-api.js';
import { errorMessage } from './wire.js';
import { isPermissionMode, MODES } from './shared/protocol.js';
import type { MsgStart, PublicState, SessionSummary, ModelOption } from './shared/protocol.js';
import { options, roots, isInsideRoots, defaultCwd, authConfigured, sdkOptions, DEV, PORT, INGRESS_PROXY } from './options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js sits one level below the app root, where public/ and
// package.json live.
const APP_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
// Reads the image's own package.json, a first-party file present by construction.
const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version: string };

// ----------------------------------------------------------- live sessions

const live = new Map<string, LiveSession>();
let knownModels: ModelOption[] | null = null;

function liveList(): SessionSummary[] {
  return [...live.values()].map((s) => s.summary());
}

function makeRoom(): void {
  const max = Math.max(1, Number(options.max_live_sessions) || 3);
  if (live.size < max) return;
  const idle = [...live.values()].filter((s) => s.status === 'idle').sort((a, b) => a.lastActivity - b.lastActivity);
  if (!idle.length) {
    throw new Error(
      `${live.size} sessions are already working. Wait for one to finish or stop it, or raise "Sessions kept running" in the add-on configuration.`
    );
  }
  idle[0].close('evicted');
}

async function startSession({ cwd, model, mode, resume }: MsgStart): Promise<LiveSession> {
  if (!authConfigured()) throw new Error('Claude is not signed in yet. Add a token in the add-on configuration.');

  let workdir = cwd || defaultCwd;
  let historyCount = 0;
  if (resume) {
    const existing = [...live.values()].find((s) => s.sessionId === resume && !s.closed);
    if (existing) return existing;
    // A session can only be resumed from the folder it was created in.
    const info = await getSessionInfo(resume).catch(() => undefined);
    if (info?.cwd) workdir = info.cwd;
    historyCount = (await getSessionMessages(resume).catch(() => [])).length;
  } else if (!isInsideRoots(workdir)) {
    throw new Error(`${workdir} is outside the folders this add-on can reach.`);
  }
  if (!fs.existsSync(workdir)) throw new Error(`${workdir} does not exist.`);

  makeRoom();
  const session = new LiveSession({
    cwd: workdir,
    model: model || options.default_model || null,
    mode: isPermissionMode(mode) ? mode : options.default_permission_mode,
    resume,
    historyCount,
    sdkOptions: sdkOptions({ options, roots, version: PKG.version }),
    idleMs: Math.max(2, Number(options.idle_timeout_minutes) || 20) * 60_000,
  });

  live.set(session.liveId, session);
  session.on('event', (entry) => broadcast({ type: 'event', liveId: session.liveId, ...entry }));
  session.on('stream', (ev) => broadcast({ type: 'event', liveId: session.liveId, seq: null, ev }));
  session.on('meta', () => broadcast({ type: 'live', live: liveList() }));
  session.on('models', (models) => {
    knownModels = models;
    broadcast({ type: 'models', models });
  });
  session.on('closed', () => {
    live.delete(session.liveId);
    broadcast({ type: 'live', live: liveList() });
  });
  broadcast({ type: 'live', live: liveList() });
  return session;
}

// -------------------------------------------------------------------- HTTP

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function remoteAllowed(req: http.IncomingMessage): boolean {
  if (DEV) return true;
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return addr === INGRESS_PROXY;
}

function publicState(): PublicState {
  return {
    version: PKG.version,
    authConfigured: authConfigured(),
    roots,
    defaultCwd,
    defaultMode: options.default_permission_mode,
    defaultModel: options.default_model || '',
    modes: MODES,
    models: knownModels,
    haApi: Boolean(options.expose_ha_api),
  };
}

const server = http.createServer(async (req, res) => {
  if (!remoteAllowed(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, publicState);

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error('request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
    else res.end();
  }
});

// --------------------------------------------------------------- WebSocket

const wsApi = createWsApi({
  publicState,
  liveList,
  need,
  startSession,
  get: (liveId) => live.get(liveId),
});
const { broadcast } = wsApi;

function need(liveId: string | null): LiveSession {
  const session = liveId ? live.get(liveId) : undefined;
  if (!session) throw new Error('That session is no longer running. Send your message again to resume it.');
  return session;
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', 'http://local');
  if (!remoteAllowed(req) || pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wsApi.handleUpgrade(req, socket, head);
});

function shutdown(): void {
  for (const session of live.values()) session.close('shutdown');
  wsApi.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code panel ${PKG.version} listening on :${PORT}${DEV ? ' (dev mode, no ingress check)' : ''}`);
  console.log(`Working folders: ${roots.map((r) => r.path).join(', ') || '(none found)'}`);
  if (!authConfigured()) console.log('No Claude credentials configured yet. Add a token in the add-on configuration.');
});
