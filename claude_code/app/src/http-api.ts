// REST routes the browser panel calls: /api/state, /api/sessions,
// /api/sessions/:id and /api/dirs. Ported from server.js:195-199 (sendJson)
// and :215-253 (handleApi).

import type { IncomingMessage, ServerResponse } from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { isInsideRoots, defaultCwd } from './options.js';
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
    const sessions = await listSessions({ limit: 300 });
    const body: SessionListItem[] = sessions
      .filter((s) => !s.cwd || isInsideRoots(s.cwd))
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
        cwd: s.cwd || null,
        lastModified: s.lastModified,
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
          message: m.message as WireSdkMessage['message'],
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
