// The session title bar and the welcome screen. Ported from
// public/app.js:662-707.

import { basename, el, SVG_NS } from './dom';
import { refs } from './refs';
import { state } from './state';
import { autosize, syncControls } from './composer';
import { currentLive } from './sidebar';

export function renderHeader(): void {
  const l = currentLive();
  refs.title.textContent = state.current.title || l?.title || 'New session';
  refs.titlePath.textContent = state.current.kind === 'new' ? '' : state.current.cwd || '';
  refs.folderLabel.textContent = labelForPath(state.current.cwd || state.config?.defaultCwd);
  document.title = `${refs.title.textContent} - Claude Code`;
}

export function labelForPath(p: string | null | undefined): string {
  if (!p) return 'Folder';
  const root = state.config?.roots.find((r) => r.path === p);
  return root ? root.label : basename(p);
}

export function renderWelcome(): void {
  const w = refs.welcome;
  w.replaceChildren();
  w.hidden = false;
  const mark = document.createElementNS(SVG_NS, 'svg');
  mark.setAttribute('class', 'mark'); mark.setAttribute('viewBox', '0 0 24 24'); mark.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use'); use.setAttribute('href', '#mark'); mark.append(use);

  if (state.config && !state.config.authConfigured) {
    w.className = 'welcome setup';
    w.append(mark, el('h2', { text: 'Sign Claude in to get started' }),
      el('p', { text: 'The add-on needs a credential before it can start a session. A Claude subscription token is the quickest route.' }),
      el('ol', null,
        el('li', null, 'On a computer with Claude Code installed, run ', el('code', { text: 'claude setup-token' }), ' and approve it in the browser.'),
        el('li', null, 'Copy the token it prints. In Home Assistant, open this add-on’s Configuration tab and paste it into “Claude subscription token”. An Anthropic API key works there too.'),
        el('li', null, 'Save, restart the add-on, and reload this page.')));
    return;
  }
  w.className = 'welcome';
  const starters: Array<[string, string]> = [
    ['Check my configuration for problems', 'Validate the YAML and read the error log'],
    ['Find automations that never run', 'Compare triggers with what my entities actually do'],
    ['Explain an automation to me', 'Pick one and walk through it step by step'],
    ['Tidy up configuration.yaml', 'Propose a split into packages, without changing behaviour'],
  ];
  w.append(mark, el('h2', { text: 'What needs doing at home?' }),
    el('p', { text: 'Claude works in your Home Assistant configuration folder and asks before it edits files or runs commands.' }),
    el('div', { class: 'starters' }, starters.map(([t, sub]) => el('button', {
      class: 'starter', type: 'button',
      onclick: () => { refs.input.value = t; autosize(); syncControls(); refs.input.focus(); },
    }, t, el('small', { text: sub })))));
}
