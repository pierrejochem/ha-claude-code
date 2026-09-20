// The panel's websocket connection. Ported from public/app.js:835-856.
//
// `connect` must not know about `refs` or the renderers, or the layering
// collapses: it reports status through callbacks instead of touching the
// connection chip itself, and leaves `syncControls()` to whatever `onStatus`
// callback main.ts (Task 17) supplies.

import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { base } from './api';
import { toast } from './shell';
import { state } from './state';

let retry = 0;

export function sendWs(payload: ClientMessage): void {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(payload));
  else toast('Not connected to the add-on. Trying again.');
}

export function connect(
  onMessage: (msg: ServerMessage) => void,
  onStatus: (s: 'connecting' | 'open' | 'down') => void,
): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws`;
  const ws = new WebSocket(url);
  state.ws = ws;
  onStatus('connecting');

  ws.onopen = () => {
    retry = 0;
    onStatus('open');
  };
  ws.onclose = () => {
    onStatus('down');
    // Closing over the same callbacks, since a bare `connect` reference
    // would drop them on every reconnect attempt.
    setTimeout(() => connect(onMessage, onStatus), Math.min(8000, 600 * 2 ** retry++));
  };
  ws.onmessage = (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data) as ServerMessage;
    } catch {
      return;
    }
    onMessage(msg);
  };
}
