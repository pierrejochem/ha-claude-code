// The working-folder popover. Ported from public/app.js:781-808.

import { el, icon, ICON } from './dom';
import { refs } from './refs';
import { state } from './state';
import { getDirs } from './api';

// See composer.ts for why this callback is registered rather than importing
// `renderHeader` from `header.ts` directly (would create an import cycle
// with `header.ts`, which imports from `composer.ts`).
let onHeaderChange: () => void = () => {};

export function initFolderPicker(onRenderHeader: () => void): void {
  onHeaderChange = onRenderHeader;
}

export async function openFolderPicker(target: string | null): Promise<void> {
  const pop = refs.popover;
  const rect = refs.folderChip.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.bottom = window.innerHeight - rect.top + 8 + 'px';

  const list = el('div', { class: 'pop-list' });
  const head = el('div', { class: 'pop-head', text: target || 'Working folder' });
  const foot = el('div', { class: 'pop-foot' });
  pop.replaceChildren(head, list, foot);

  if (!target) {
    // The picker cannot open before `hello` arrives, so this is a
    // type-level guard for `state.config: PublicState | null`, not a
    // behaviour change from the original unguarded `state.config.roots`.
    for (const r of state.config?.roots ?? []) {
      list.append(el('button', {
        class: 'pop-item',
        type: 'button',
        // This handler replaces the popover's children, detaching this button.
        // Without stopping the click here it reaches main.ts's click-outside
        // handler, which sees a target that is no longer inside the popover and
        // hides it. refs.folderChip's own handler stops propagation for the
        // same reason.
        onclick: (e) => { e.stopPropagation(); void openFolderPicker(r.path); },
      }, icon(ICON.folder), r.label, el('small', { text: r.path })));
    }
    return;
  }
  try {
    const data = await getDirs(target);
    list.append(el('button', {
      class: 'pop-item',
      type: 'button',
      onclick: (e) => { e.stopPropagation(); void openFolderPicker(data.parent); },
    }, icon(ICON.up), data.parent ? 'Up one level' : 'All folders'));
    for (const d of data.dirs) {
      list.append(el('button', {
        class: 'pop-item',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); void openFolderPicker(data.path + '/' + d); },
      }, icon(ICON.folder), d));
    }
    if (!data.dirs.length) list.append(el('p', { class: 'session-empty', text: 'No folders inside this one.' }));
    foot.append(el('button', { class: 'btn primary', type: 'button', text: 'Work in this folder', onclick: () => { state.current.cwd = data.path; pop.hidden = true; onHeaderChange(); } }));
  } catch (err) {
    list.append(el('p', { class: 'session-empty', text: err instanceof Error ? err.message : String(err) }));
  }
}
