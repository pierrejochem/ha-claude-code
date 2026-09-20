// Line-level diff view for edit tool calls. Ported from public/app.js:207-238.

import { el } from './dom';

export type DiffOp = ['ctx' | 'add' | 'del', string];

export function lineDiff(a: string, b: string): DiffOp[] {
  const A = a.split('\n'),
    B = b.split('\n');
  if (A.length * B.length > 250000)
    return [...A.map((t): DiffOp => ['del', t]), ...B.map((t): DiffOp => ['add', t])];
  const n = A.length,
    m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: DiffOp[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push(['ctx', A[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['del', A[i++]]);
    else ops.push(['add', B[j++]]);
  }
  while (i < n) ops.push(['del', A[i++]]);
  while (j < m) ops.push(['add', B[j++]]);
  return ops;
}

export function diffView(oldText: unknown, newText: unknown): HTMLElement {
  const ops = lineDiff(String(oldText || ''), String(newText || ''));
  const box = el('div', { class: 'diff' });
  // Keep three lines of context around each change, like a unified diff.
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, k) => {
    if (op[0] !== 'ctx') for (let d = -3; d <= 3; d++) if (ops[k + d]) keep[k + d] = 1;
  });
  let gap = false;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      if (!gap && k) box.append(el('div', { class: 'gap', text: '⋯' }));
      gap = true;
      return;
    }
    gap = false;
    box.append(el('div', { class: op[0], text: op[1] || ' ' }));
  });
  return el('div', { class: 'codeblock' }, box);
}
