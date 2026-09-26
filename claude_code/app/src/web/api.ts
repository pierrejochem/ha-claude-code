// The panel's REST client. Ported from public/app.js:69-74, plus the typed
// callers so no other module builds a URL by hand.

import type { DirListing, SessionDetail, SessionListItem } from '../shared/protocol';

export const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base + 'api/' + path, init);
  const body: unknown = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${r.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const getSessions = (): Promise<SessionListItem[]> => api<SessionListItem[]>('sessions');
export const getSession = (id: string, limit?: number): Promise<SessionDetail> =>
  api<SessionDetail>(`sessions/${id}${limit ? `?limit=${limit}` : ''}`);
export const getDirs = (path: string): Promise<DirListing> => api<DirListing>('dirs?path=' + encodeURIComponent(path));
/** Removes a saved session's transcript. The server refuses while it is working. */
export const deleteSession = (id: string): Promise<{ deleted: string }> =>
  api<{ deleted: string }>(`sessions/${id}`, { method: 'DELETE' });
