// The message composer: autosize, control syncing, submit, attachments and
// the model/mode selects. Ported from public/app.js:709-778, 820-826.

import type { MsgStart, PermissionMode } from '../shared/protocol';
import { el } from './dom';
import { refs } from './refs';
import { state, MODE_LABEL } from './state';
import { sendWs } from './socket';
import { toast } from './shell';
import { currentLive } from './sidebar';

// `header.ts` (Task 15) imports `autosize` and `syncControls` from this
// module, so this module cannot import `renderHeader` back from `header.ts`
// without a cycle. `main.ts` (Task 17) registers the real callback with
// `initComposer(renderHeader)` during wiring; until then this is a no-op.
let onHeaderChange: () => void = () => {};

export function initComposer(onRenderHeader: () => void): void {
  onHeaderChange = onRenderHeader;
}

export function autosize(): void {
  const t = refs.input;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px';
}

export function syncControls(): void {
  const l = currentLive();
  const status = l?.status;
  const busy = status === 'running' || status === 'starting' || status === 'waiting' || Boolean(state.pendingStart);
  const ready = Boolean(state.config?.authConfigured) && state.ws?.readyState === 1;
  refs.stop.hidden = !busy || !l;
  refs.send.hidden = !refs.stop.hidden;
  refs.send.disabled = !ready || (!refs.input.value.trim() && !state.images.length) || Boolean(state.pendingStart);
  refs.working.hidden = !(status === 'running' || status === 'starting' || state.pendingStart);
  refs.folderChip.disabled = state.current.kind !== 'new';
  refs.mode.value = l?.mode || state.draftMode;
  if (l?.model && ![...refs.model.options].some((o) => o.value === l.model)) refs.model.append(new Option(l.model, l.model));
  refs.model.value = l?.model && l.model !== state.config?.defaultModel ? l.model : state.draftModel;
  refs.input.placeholder = !state.config?.authConfigured ? 'Sign Claude in first'
    : busy && l ? 'Add to what Claude is doing' : state.current.kind === 'new' ? 'Describe what you want done' : 'Reply to Claude';
}

export function submit(): void {
  const text = refs.input.value.trim();
  if ((!text && !state.images.length) || refs.send.disabled) return;
  const images = state.images.map(({ mediaType, data }) => ({ mediaType, data }));

  // `state.current.liveId` is nullable on `CurrentSession`, but `currentLive()`
  // (app.js:582) only ever returns a match when `state.current.liveId` is
  // truthy, so this outer check already implies it; the extra
  // `state.current.liveId &&` here just gives the type checker the same
  // guarantee without asserting it, and never changes which branch runs.
  if (state.current.kind === 'live' && state.current.liveId && currentLive()) {
    sendWs({ type: 'send', liveId: state.current.liveId, text, images });
  } else {
    const reqId = Math.random().toString(36).slice(2);
    state.pendingStart = { reqId, text, target: state.current };
    const startMsg: MsgStart = {
      type: 'start', reqId, text, images,
      cwd: state.current.cwd || state.config?.defaultCwd,
      mode: state.draftMode, model: state.draftModel,
      // `state.current.sessionId` is only ever non-null when `kind === 'disk'`
      // by construction (app.js:635 sets both from the same disk session),
      // but that invariant isn't encoded in `CurrentSession`'s type, so the
      // `&& state.current.sessionId` guard is needed to keep `resume` at
      // `string | undefined` without ever changing which value is sent.
      resume: state.current.kind === 'disk' && state.current.sessionId ? state.current.sessionId : undefined,
    };
    sendWs(startMsg);
    refs.welcome.hidden = true;
    if (!state.current.title) state.current.title = text.slice(0, 80);
    onHeaderChange();
  }
  refs.input.value = '';
  state.images = [];
  renderAttachments(); autosize(); syncControls();
}

export function renderAttachments(): void {
  refs.attachments.hidden = !state.images.length;
  refs.attachments.replaceChildren(...state.images.map((img, i) => el('div', { class: 'attachment' },
    el('img', { src: img.url, alt: img.name || 'Attached image' }),
    el('button', { type: 'button', 'aria-label': 'Remove image', text: '×', onclick: () => { state.images.splice(i, 1); renderAttachments(); syncControls(); } }))));
}

export function addFiles(files: Iterable<File>): void {
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Only PNG, JPEG, GIF and WebP images can be attached.'); continue; }
    if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is over 5 MB.`); continue; }
    if (state.images.length >= 6) { toast('Six images per message at most.'); break; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      state.images.push({ name: file.name, mediaType: file.type, url, data: url.slice(url.indexOf(',') + 1) });
      renderAttachments(); syncControls();
    };
    reader.readAsDataURL(file);
  }
}

export function fillSelects(): void {
  const modes: readonly PermissionMode[] = state.config?.modes ?? ['default'];
  refs.mode.replaceChildren(...modes.map((m) => new Option(MODE_LABEL[m] || m, m)));
  const models = state.models || [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }];
  const def = state.config?.defaultModel;
  refs.model.replaceChildren(new Option(def ? `Default (${def})` : 'Default model', ''),
    ...models.filter((m) => m.value && m.value !== 'default').map((m) => new Option(m.name || m.value, m.value)));
}
