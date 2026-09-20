import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { LiveSession } from './lib/live-session.js';
import { buildSystemAppend } from './lib/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// DEV=1 runs the panel outside Home Assistant (npm run dev): no ingress IP
// check, and the current directory becomes a working folder.
const DEV = process.env.DEV === '1';
const PORT = Number(process.env.PORT || 8099);
const INGRESS_PROXY = '172.30.32.2';
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];

// ------------------------------------------------------------------ options

function loadOptions() {
  const defaults = {
    claude_oauth_token: '',
    anthropic_api_key: '',
    default_model: '',
    default_permission_mode: 'default',
    working_directory: '/homeassistant',
    expose_ha_api: true,
    protect_secrets: true,
    max_live_sessions: 3,
    idle_timeout_minutes: 20,
  };
  try {
    const file = process.env.OPTIONS_PATH || '/data/options.json';
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return defaults;
  }
}

const options = loadOptions();
if (options.anthropic_api_key) process.env.ANTHROPIC_API_KEY = options.anthropic_api_key;
if (options.claude_oauth_token) process.env.CLAUDE_CODE_OAUTH_TOKEN = options.claude_oauth_token;

const ROOT_LABELS = {
  '/homeassistant': 'Home Assistant config',
  '/config': 'Add-on files',
  '/share': 'Share',
};
const roots = Object.keys(ROOT_LABELS)
  .filter((p) => fs.existsSync(p))
  .map((p) => ({ path: p, label: ROOT_LABELS[p] }));
if (DEV) roots.push({ path: process.cwd(), label: 'Dev folder' });

const defaultCwd = isInsideRoots(options.working_directory) && fs.existsSync(options.working_directory)
  ? options.working_directory
  : roots[0]?.path || process.cwd();

function isInsideRoots(candidate) {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  return roots.some((r) => resolved === r.path || resolved.startsWith(r.path + path.sep));
}

function authConfigured() {
  // On macOS the CLI login lives in the Keychain, which we cannot probe; assume it in dev.
  if (DEV) return true;
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
}

// Options shared by every session. cwd, model, mode and resume are per session.
function sdkOptions() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `ha-claude-code/${PKG.version}` };
  if (!options.expose_ha_api) delete env.SUPERVISOR_TOKEN;

  const disallowedTools = [];
  if (options.protect_secrets) {
    // "//" anchors a rule at the filesystem root.
    for (const tool of ['Read', 'Edit']) {
      disallowedTools.push(
        `${tool}(//homeassistant/secrets.yaml)`,
        `${tool}(//homeassistant/.storage/auth)`,
        `${tool}(//homeassistant/.storage/auth_provider.*)`,
        `${tool}(//homeassistant/.storage/onboarding)`,
        `${tool}(//homeassistant/.cloud/**)`
      );
    }
  }

  return {
    env,
    disallowedTools,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildSystemAppend({ exposeHaApi: options.expose_ha_api, roots }),
    },
    // Loads CLAUDE.md, .claude/settings*.json and skills from the working folder and from ~/.claude.
    settingSources: ['user', 'project', 'local'],
  };
}

// ----------------------------------------------------------- live sessions

const live = new Map(); // liveId -> LiveSession
const clients = new Set();
let knownModels = null;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function liveList() {
  return [...live.values()].map((s) => s.summary());
}

function makeRoom() {
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

async function startSession({ cwd, model, mode, resume }) {
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
    mode: MODES.includes(mode) ? mode : options.default_permission_mode,
    resume,
    historyCount,
    sdkOptions: sdkOptions(),
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function remoteAllowed(req) {
  if (DEV) return true;
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return addr === INGRESS_PROXY;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function publicState() {
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

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api/, '');

  if (route === '/state') return sendJson(res, 200, publicState());

  if (route === '/sessions') {
    const sessions = await listSessions({ limit: 300 });
    return sendJson(
      res,
      200,
      sessions
        .filter((s) => !s.cwd || isInsideRoots(s.cwd))
        .map((s) => ({ sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled', cwd: s.cwd || null, lastModified: s.lastModified }))
    );
  }

  const one = route.match(/^\/sessions\/([0-9a-f-]{36})$/i);
  if (one) {
    const limit = Number(url.searchParams.get('limit')) || undefined;
    const [info, messages] = await Promise.all([
      getSessionInfo(one[1]).catch(() => undefined),
      getSessionMessages(one[1], limit ? { limit } : undefined),
    ]);
    return sendJson(res, 200, {
      info: info ? { sessionId: info.sessionId, title: info.customTitle || info.summary, cwd: info.cwd || null } : null,
      messages: messages.map((m) => ({ type: m.type, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id ?? null, message: m.message })),
    });
  }

  if (route === '/dirs') {
    const target = path.resolve(url.searchParams.get('path') || defaultCwd);
    if (!isInsideRoots(target)) return sendJson(res, 403, { error: 'Outside the folders this add-on can reach.' });
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !['node_modules', '__pycache__', '.git'].includes(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(target);
    return sendJson(res, 200, { path: target, parent: isInsideRoots(parent) ? parent : null, dirs });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  if (!remoteAllowed(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

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
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
    else res.end();
  }
});

// --------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://local');
  if (!remoteAllowed(req) || pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', state: publicState(), live: liveList() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const reply = (payload) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload));

    try {
      switch (msg.type) {
        case 'start': {
          const session = await startSession(msg);
          reply({ type: 'started', reqId: msg.reqId, session: session.summary() });
          session.send(msg.text || '', sanitizeImages(msg.images));
          break;
        }
        case 'send':
          need(msg.liveId).send(msg.text || '', sanitizeImages(msg.images));
          break;
        case 'attach': {
          const session = need(msg.liveId);
          reply({ type: 'replay', liveId: session.liveId, session: session.summary(), entries: session.replaySince(msg.since || 0) });
          break;
        }
        case 'interrupt':
          await need(msg.liveId).interrupt();
          break;
        case 'permission':
          need(msg.liveId).answerPermission(msg.requestId, msg.decision || { behavior: 'deny' });
          break;
        case 'set_mode':
          if (!MODES.includes(msg.mode)) throw new Error('Unknown permission mode.');
          await need(msg.liveId).setMode(msg.mode);
          break;
        case 'set_model':
          await need(msg.liveId).setModel(msg.model);
          break;
        case 'close':
          live.get(msg.liveId)?.close('user');
          break;
        default:
          break;
      }
    } catch (err) {
      reply({ type: 'error', reqId: msg.reqId || null, liveId: msg.liveId || null, message: String(err?.message || err) });
    }
  });
});

function need(liveId) {
  const session = live.get(liveId);
  if (!session) throw new Error('That session is no longer running. Send your message again to resume it.');
  return session;
}

function sanitizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((i) => /^image\/(png|jpeg|gif|webp)$/.test(i?.mediaType) && typeof i.data === 'string')
    .slice(0, 6)
    .map((i) => ({ mediaType: i.mediaType, data: i.data }));
}

// Ingress and mobile browsers drop silent sockets; ping keeps them open and
// clears out the ones that are gone.
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000).unref();

function shutdown() {
  for (const session of live.values()) session.close('shutdown');
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
