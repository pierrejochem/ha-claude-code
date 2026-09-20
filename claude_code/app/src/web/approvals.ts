// Permission cards: the approve/deny UI for tool-use requests, plan review,
// and multiple-choice questions from Claude. Ported from public/app.js:498-578.

import { basename, el } from './dom';
import { refs } from './refs';
import { state } from './state';
import { stick } from './scroll';
import { md } from './markdown';
import { describeTool, toolInputView, asToolInput, type QuestionSpec } from './tools';
import { sendWs } from './socket';
import { toast } from './shell';
import type { EvPermission, PermissionDecision } from '../shared/protocol';

// -------------------------------------------------------------- approvals
export function permissionTitle(a: EvPermission): string {
  if (a.title) return a.title;
  const input = asToolInput(a.input);
  const f = basename(input.file_path);
  switch (a.toolName) {
    case 'Bash':
      return 'Allow Claude to run this command?';
    case 'Edit':
    case 'MultiEdit':
      return `Allow Claude to edit ${f}?`;
    case 'Write':
      return `Allow Claude to write ${f}?`;
    case 'Read':
      return `Allow Claude to read ${f}?`;
    case 'WebFetch':
      return 'Allow Claude to fetch this page?';
    default:
      return `Allow Claude to use ${describeTool(a.toolName, input).filter(Boolean).join(' ')}?`;
  }
}

function answer(a: EvPermission, decision: PermissionDecision): void {
  // state.current.liveId types as nullable, but a permission event can only
  // reach state.approvals through the 'event' branch in main.ts's dispatcher,
  // which requires msg.liveId === state.current.liveId before calling into
  // applyEvent — so it is a string by the time an approval card exists.
  sendWs({ type: 'permission', liveId: state.current.liveId!, requestId: a.requestId, decision });
  state.approvals = state.approvals.filter((x) => x.requestId !== a.requestId);
  renderApprovals();
}

export function renderApprovals(): void {
  refs.approvals.replaceChildren();
  const a = state.approvals[0];
  if (!a) return;
  const card = el('div', { class: 'perm', role: 'group', 'aria-label': 'Claude needs your approval' });
  if (state.approvals.length > 1)
    card.append(el('p', { class: 'perm-more', text: `${state.approvals.length - 1} more waiting after this one` }));

  if (a.toolName === 'AskUserQuestion') renderQuestions(card, a);
  else if (a.toolName === 'ExitPlanMode') {
    const input = asToolInput(a.input);
    card.append(
      el('h3', { text: 'Start on this plan?' }),
      el('div', { class: 'plan prose' }, md(input.plan || '')),
      el(
        'div',
        { class: 'perm-actions' },
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Keep planning',
          onclick: () => answer(a, { behavior: 'deny', message: 'Keep refining the plan; do not start yet.' }),
        }),
        el('button', { class: 'btn primary', type: 'button', text: 'Approve plan', onclick: () => answer(a, { behavior: 'allow' }) }),
      ),
    );
  } else {
    const input = asToolInput(a.input);
    const note = el('input', { type: 'text', placeholder: 'Or tell Claude what to do instead', 'aria-label': 'Message to send with Deny' });
    const deny = () => answer(a, { behavior: 'deny', message: note.value });
    note.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && note.value.trim()) deny();
    });
    const sub = [a.description, a.reason, a.blockedPath ? `Path: ${a.blockedPath}` : null, a.subagent ? 'Requested by a sub-agent' : null]
      .filter(Boolean)
      .join(' ');
    // app.js:537 passed `sub ? el(...) : null` straight into the native
    // `card.append()`. `Element.append()`'s signature is `(Node | string)`,
    // which does not accept `null` (unlike the `el()` helper, which treats a
    // null child as "omit"); filtering here keeps that same "omit when
    // falsy" behavior instead of letting `null` reach `append()` at all.
    card.append(
      ...([el('h3', { text: permissionTitle(a) }), sub ? el('p', { class: 'sub', text: sub }) : null] as Array<HTMLElement | null>).filter(
        (c): c is HTMLElement => c !== null,
      ),
      el('div', { class: 'detail' }, toolInputView(a.toolName, input)),
      el(
        'div',
        { class: 'perm-actions' },
        note,
        el('button', { class: 'btn', type: 'button', text: 'Deny', onclick: deny }),
        a.canAlways
          ? el('button', {
              class: 'btn',
              type: 'button',
              text: 'Always allow',
              title: a.alwaysLabel ? `Adds a rule: ${a.alwaysLabel}` : null,
              onclick: () => answer(a, { behavior: 'always' }),
            })
          : null,
        el('button', { class: 'btn primary', type: 'button', text: 'Allow once', onclick: () => answer(a, { behavior: 'allow' }) }),
      ),
    );
  }
  refs.approvals.append(card);
  stick(true);
}

function renderQuestions(card: HTMLElement, a: EvPermission): void {
  const input = asToolInput(a.input);
  const questions: QuestionSpec[] = input.questions || [];
  card.append(el('h3', { text: questions.length === 1 ? 'Claude has a question' : 'Claude has a few questions' }));
  const form = el('div');
  questions.forEach((q, qi) => {
    const group = el('fieldset', { class: 'question' }, el('legend', { text: q.question }));
    (q.options || []).forEach((opt, oi) => {
      group.append(
        el(
          'label',
          { class: 'option' },
          el('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `q${qi}`, value: opt.label, 'data-q': qi, id: `q${qi}o${oi}` }),
          el('span', null, opt.label, opt.description ? el('small', { text: opt.description }) : null),
        ),
      );
    });
    group.append(
      el('input', { class: 'option-other', type: 'text', placeholder: 'Something else', 'data-other': qi, 'aria-label': `Your own answer to: ${q.question}` }),
    );
    form.append(group);
  });
  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const other = form.querySelector<HTMLInputElement>(`[data-other="${qi}"]`)?.value.trim() ?? '';
      const picked = [...form.querySelectorAll<HTMLInputElement>(`input[data-q="${qi}"]:checked`)].map((i) => i.value);
      answers[q.question] = other || picked.join(', ');
    });
    if (Object.values(answers).some((v) => !v)) return toast('Pick an option or type your own answer for each question.');
    answer(a, { behavior: 'allow', answers });
  };
  card.append(
    form,
    el(
      'div',
      { class: 'perm-actions' },
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Skip',
        onclick: () => answer(a, { behavior: 'deny', message: 'The user skipped the question. Use your best judgement or ask in plain text.' }),
      }),
      el('button', { class: 'btn primary', type: 'button', text: 'Send answers', onclick: submit }),
    ),
  );
}
