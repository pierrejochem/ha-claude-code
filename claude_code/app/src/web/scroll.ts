// Transcript auto-scroll: stick to the bottom while the user is already
// near it, but leave the scroll position alone once they have scrolled up
// to read history. Ported from public/app.js:325-338.

import { refs } from './refs';

// The JS hangs this as `stick.wanted` on the function itself; TypeScript
// will not accept a property on a function value, so it is a module-local
// instead. `markStick()` lets transcript.ts set it the way app.js:449 does.
let stickWanted = false;

export function nearBottom(): boolean {
  const s = refs.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}

export function stick(force?: boolean): void {
  if (force || stickWanted) requestAnimationFrame(() => (refs.scroller.scrollTop = refs.scroller.scrollHeight));
}

export function place(node: Node, before?: Node | null): void {
  stickWanted = nearBottom();
  if (before && before.parentNode === refs.transcript) refs.transcript.insertBefore(node, before);
  else refs.transcript.append(node);
  stick();
}

export function markStick(): void {
  stickWanted = nearBottom();
}
