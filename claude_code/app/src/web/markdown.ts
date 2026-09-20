// Markdown rendering: builds DOM nodes directly, so model output can never
// inject markup. Ported from public/app.js:76-205.

import { el } from './dom';

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*][\s\S]*?)\*\*|\*([^*\s][^*]*?)\*|~~([\s\S]+?)~~|(https?:\/\/[^\s<>)\]]+)/g;

export function inline<T extends ParentNode>(text: string, into: T): T {
  // A fresh regex per call: inline() recurses, and a shared lastIndex would loop forever.
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) into.append(text.slice(last, m.index));
    if (m[1]) {
      const code = m[2] ?? '';
      into.append(el('code', { text: code.trim() }));
    } else if (m[3]) {
      const href = m[4] ?? '';
      const safe = /^(https?:|mailto:)/i.test(href);
      const a = el(safe ? 'a' : 'span', safe ? { href, target: '_blank', rel: 'noopener noreferrer' } : null);
      inline(m[3], a);
      into.append(a);
    } else if (m[5]) {
      const b = el('strong');
      inline(m[5], b);
      into.append(b);
    } else if (m[6]) {
      const i = el('em');
      inline(m[6], i);
      into.append(i);
    } else if (m[7]) {
      const s = el('del');
      inline(m[7], s);
      into.append(s);
    } else if (m[8]) {
      into.append(el('a', { href: m[8], target: '_blank', rel: 'noopener noreferrer', text: m[8] }));
    }
    last = re.lastIndex;
  }
  if (last < text.length) into.append(text.slice(last));
  return into;
}

export function codeBlock(code: string, lang?: string): HTMLElement {
  const copy = el('button', { type: 'button', text: 'Copy' });
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(code).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1400);
    });
  });
  return el(
    'div',
    { class: 'codeblock' },
    el('div', { class: 'codeblock-head' }, el('span', { text: lang || 'text' }), copy),
    el('pre', null, el('code', { text: code })),
  );
}

const RE_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RE_FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const RE_HEAD = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string): string[] =>
  line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function md(text: unknown): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const startsBlock = (l: string): boolean =>
    RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) || RE_LIST.test(l) || /^\s*>/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    let m = line.match(RE_FENCE);
    if (m) {
      const fence = m[1];
      const lang = m[2];
      const buf: string[] = [];
      i++;
      const close = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.append(codeBlock(buf.join('\n'), lang));
      continue;
    }
    if ((m = line.match(RE_HEAD))) {
      out.append(inline(m[2], el('h' + m[1].length)));
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      out.append(el('hr'));
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.append(el('blockquote', null, md(buf.join('\n'))));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i++]);
        tbody.append(el('tr', null, head.map((_, c) => inline(row[c] || '', el('td')))));
      }
      out.append(
        el(
          'div',
          { class: 'table-wrap' },
          el('table', null, el('thead', null, el('tr', null, head.map((h) => inline(h, el('th'))))), tbody),
        ),
      );
      continue;
    }

    if ((m = line.match(RE_LIST))) {
      const indent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const list = el(ordered ? 'ol' : 'ul');
      if (ordered) {
        const n = parseInt(m[2], 10);
        if (n !== 1) list.setAttribute('start', String(n));
      }
      while (i < lines.length) {
        const lm = lines[i].match(RE_LIST);
        if (!lm || lm[1].length !== indent) break;
        const first = lm[3];
        const rest: string[] = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const next = lines[i + 1];
            if (next != null && next.trim() && (/^\s*/.exec(next)?.[0] ?? '').length > indent) {
              rest.push('');
              i++;
              continue;
            }
            break;
          }
          if ((/^\s*/.exec(l)?.[0] ?? '').length <= indent) break;
          rest.push(l);
          i++;
        }
        const li = inline(first, el('li'));
        if (rest.length) {
          const strip = Math.min(
            ...rest.filter((r) => r.trim()).map((r) => (/^\s*/.exec(r)?.[0] ?? '').length),
          );
          li.append(md(rest.map((r) => r.slice(strip)).join('\n')));
        }
        list.append(li);
        while (
          i < lines.length &&
          !lines[i].trim() &&
          lines[i + 1] != null &&
          RE_LIST.test(lines[i + 1]) &&
          (RE_LIST.exec(lines[i + 1])?.[1]?.length ?? -1) === indent
        )
          i++;
      }
      out.append(list);
      continue;
    }

    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !startsBlock(lines[i]) &&
      !(lines[i].includes('|') && lines[i + 1] != null && RE_TABLE_SEP.test(lines[i + 1]))
    )
      buf.push(lines[i++]);
    const p = el('p');
    buf.forEach((l, n) => {
      if (n) p.append(el('br'));
      inline(l, p);
    });
    out.append(p);
  }
  return out;
}
