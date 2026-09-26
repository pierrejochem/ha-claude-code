// REST routes the browser panel calls: /api/state, /api/sessions,
// /api/sessions/:id and /api/dirs. Ported from server.js:195-199 (sendJson)
// and :215-253 (handleApi).

import type { IncomingMessage, ServerResponse } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { isInsideRoots, defaultCwd, configDir, extraSessionDirs } from './options.js';
import { syncSessionMirror } from './session-mirror.js';
import { slimMessage } from './wire.js';
import type { PublicState, SessionListItem, SessionDetail, DirListing, WireSdkMessage } from './shared/protocol.js';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

export async function handleApi(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  publicState: () => PublicState
): Promise<void> {
  const route = url.pathname.replace(/^\/api/, '');

  if (route === '/state') return sendJson(res, 200, publicState());

  if (route === '/sessions') {
    // Pick up transcripts from the extra config folders before listing, so a
    // session another `claude` on this machine started a moment ago is in it.
    const mirror = await syncSessionMirror(extraSessionDirs.dirs, configDir);
    for (const message of mirror.errors) console.error(`session mirror: ${message}`);

    const sessions = await listSessions({ limit: 300 });
    // Sessions whose folder is out of reach used to be dropped here. They are
    // listed and marked instead: a borrowed session usually ran somewhere this
    // add-on cannot write, and hiding it is what made the panel look as though
    // it only knew about its own sessions.
    const body: SessionListItem[] = sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
      cwd: s.cwd || null,
      lastModified: s.lastModified,
      reachable: !s.cwd || isInsideRoots(s.cwd),
    }));
    return sendJson(res, 200, body);
  }

  const one = route.match(/^\/sessions\/([0-9a-f-]{36})$/i);
  if (one) {
    const limit = Number(url.searchParams.get('limit')) || undefined;
    const [info, messages] = await Promise.all([
      getSessionInfo(one[1]).catch(() => undefined),
      getSessionMessages(one[1], limit ? { limit } : undefined),
    ]);
    const body: SessionDetail = {
      info: info ? { sessionId: info.sessionId, title: info.customTitle || info.summary, cwd: info.cwd || null } : null,
      messages: messages.map((m): WireSdkMessage => {
        // The SDK types this as 'user' | 'assistant' | 'system', but
        // getSessionMessages' includeSystemMessages option defaults to false and we
        // never pass it, so the SDK filters 'system' entries out before returning.
        // Only 'user' and 'assistant' can reach here.
        return {
          type: m.type as WireSdkMessage['type'],
          uuid: m.uuid,
          parent_tool_use_id: m.parent_tool_use_id ?? null,
          // Same narrowing the live path applies in live-session.ts, so a
          // replayed transcript matches what the session showed while running:
          // tool results clipped at MAX_RESULT_CHARS and image blocks reduced to
          // their type. slimMessage takes `unknown` and returns WireMessage, so
          // no cast is needed here.
          message: slimMessage(m.message),
        };
      }),
    };
    return sendJson(res, 200, body);
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
    const body: DirListing = { path: target, parent: isInsideRoots(parent) ? parent : null, dirs };
    return sendJson(res, 200, body);
  }

  return sendJson(res, 404, { error: 'Not found' });
}
