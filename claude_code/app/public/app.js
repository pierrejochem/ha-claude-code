(() => {
  'use strict';

  // ------------------------------------------------------------ tiny DOM kit
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(d, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  }
  const ICON = {
    chev: 'M9 6l6 6-6 6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    cross: 'M6 6l12 12M18 6L6 18',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    up: 'M12 19V5M6 11l6-6 6 6',
  };
  const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

  // ------------------------------------------------------------------ state
  const state = {
    config: null,
    sessions: [],
    live: [],
    models: null,
    // kind: 'new' | 'disk' | 'live'
    current: { kind: 'new', liveId: null, sessionId: null, cwd: null, title: null, loading: false },
    lastSeq: 0,
    pendingStart: null,
    draftMode: 'default',
    draftModel: '',
    images: [],
    approvals: [],
    tools: new Map(),
    drafts: new Map(),
    todosEl: null,
  };

  const refs = {
    app: $('app'), list: $('sessionList'), transcript: $('transcript'), welcome: $('welcome'),
    scroller: $('scroller'), working: $('working'), approvals: $('approvals'), input: $('input'),
    send: $('sendBtn'), stop: $('stopBtn'), title: $('title'), titlePath: $('titlePath'),
    folderChip: $('folderChip'), folderLabel: $('folderLabel'), mode: $('modeSelect'), model: $('modelSelect'),
    conn: $('conn'), connText: $('connText'), popover: $('folderPopover'), toast: $('toast'),
    attachments: $('attachments'), file: $('fileInput'), fineprint: $('fineprint'),
  };

  const MODE_LABEL = { default: 'Ask permissions', acceptEdits: 'Accept edits', plan: 'Plan mode', auto: 'Auto mode' };
  const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  const api = (p) => fetch(base + 'api/' + p).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
    return body;
  });

  // --------------------------------------------------------------- markdown
  // Builds DOM nodes directly, so model output can never inject markup.
  const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*][\s\S]*?)\*\*|\*([^*\s][^*]*?)\*|~~([\s\S]+?)~~|(https?:\/\/[^\s<>)\]]+)/g;

  function inline(text, into) {
    // A fresh regex per call: inline() recurses, and a shared lastIndex would loop forever.
    const re = new RegExp(INLINE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) into.append(text.slice(last, m.index));
      if (m[1]) into.append(el('code', { text: m[2].trim() }));
      else if (m[3]) {
        const safe = /^(https?:|mailto:)/i.test(m[4]);
        const a = el(safe ? 'a' : 'span', safe ? { href: m[4], target: '_blank', rel: 'noopener noreferrer' } : null);
        inline(m[3], a);
        into.append(a);
      } else if (m[5]) { const b = el('strong'); inline(m[5], b); into.append(b); }
      else if (m[6]) { const i = el('em'); inline(m[6], i); into.append(i); }
      else if (m[7]) { const s = el('del'); inline(m[7], s); into.append(s); }
      else if (m[8]) into.append(el('a', { href: m[8], target: '_blank', rel: 'noopener noreferrer', text: m[8] }));
      last = re.lastIndex;
    }
    if (last < text.length) into.append(text.slice(last));
    return into;
  }

  function codeBlock(code, lang) {
    const copy = el('button', { type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1400);
      });
    });
    return el('div', { class: 'codeblock' },
      el('div', { class: 'codeblock-head' }, el('span', { text: lang || 'text' }), copy),
      el('pre', null, el('code', { text: code })));
  }

  const RE_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const RE_FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
  const RE_HEAD = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function md(text) {
    const out = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    const startsBlock = (l) => RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) || RE_LIST.test(l) || /^\s*>/.test(l);

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m = line.match(RE_FENCE);
      if (m) {
        const fence = m[1]; const lang = m[2]; const buf = [];
        i++;
        const close = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
        while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.append(codeBlock(buf.join('\n'), lang));
        continue;
      }
      if ((m = line.match(RE_HEAD))) { out.append(inline(m[2], el('h' + m[1].length))); i++; continue; }
      if (RE_HR.test(line)) { out.append(el('hr')); i++; continue; }

      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.append(el('blockquote', null, md(buf.join('\n'))));
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const head = cells(line); i += 2;
        const tbody = el('tbody');
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const row = cells(lines[i++]);
          tbody.append(el('tr', null, head.map((_, c) => inline(row[c] || '', el('td')))));
        }
        out.append(el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, head.map((h) => inline(h, el('th'))))), tbody)));
        continue;
      }

      if ((m = line.match(RE_LIST))) {
        const indent = m[1].length;
        const ordered = /\d/.test(m[2]);
        const list = el(ordered ? 'ol' : 'ul');
        if (ordered) { const n = parseInt(m[2], 10); if (n !== 1) list.setAttribute('start', n); }
        while (i < lines.length) {
          const lm = lines[i].match(RE_LIST);
          if (!lm || lm[1].length !== indent) break;
          const first = lm[3]; const rest = [];
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              const next = lines[i + 1];
              if (next != null && next.trim() && next.match(/^\s*/)[0].length > indent) { rest.push(''); i++; continue; }
              break;
            }
            if (l.match(/^\s*/)[0].length <= indent) break;
            rest.push(l); i++;
          }
          const li = inline(first, el('li'));
          if (rest.length) {
            const strip = Math.min(...rest.filter((r) => r.trim()).map((r) => r.match(/^\s*/)[0].length));
            li.append(md(rest.map((r) => r.slice(strip)).join('\n')));
          }
          list.append(li);
          while (i < lines.length && !lines[i].trim() && lines[i + 1] != null && RE_LIST.test(lines[i + 1]) && lines[i + 1].match(RE_LIST)[1].length === indent) i++;
        }
        out.append(list);
        continue;
      }

      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) &&
        !(lines[i].includes('|') && lines[i + 1] != null && RE_TABLE_SEP.test(lines[i + 1]))) buf.push(lines[i++]);
      const p = el('p');
      buf.forEach((l, n) => { if (n) p.append(el('br')); inline(l, p); });
      out.append(p);
    }
    return out;
  }

  // ------------------------------------------------------------------- diff
  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    if (A.length * B.length > 250000) return [...A.map((t) => ['del', t]), ...B.map((t) => ['add', t])];
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push(['ctx', A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['del', A[i++]]);
      else ops.push(['add', B[j++]]);
    }
    while (i < n) ops.push(['del', A[i++]]);
    while (j < m) ops.push(['add', B[j++]]);
    return ops;
  }

  function diffView(oldText, newText) {
    const ops = lineDiff(oldText || '', newText || '');
    const box = el('div', { class: 'diff' });
    // Keep three lines of context around each change, like a unified diff.
    const keep = new Uint8Array(ops.length);
    ops.forEach((op, k) => { if (op[0] !== 'ctx') for (let d = -3; d <= 3; d++) if (ops[k + d]) keep[k + d] = 1; });
    let gap = false;
    ops.forEach((op, k) => {
      if (!keep[k]) { if (!gap && k) box.append(el('div', { class: 'gap', text: '⋯' })); gap = true; return; }
      gap = false;
      box.append(el('div', { class: op[0], text: op[1] || ' ' }));
    });
    return el('div', { class: 'codeblock' }, box);
  }

  // ------------------------------------------------------------- tool rows
  function describeTool(name, input = {}) {
    const file = input.file_path || input.path || input.notebook_path;
    switch (name) {
      case 'Read': return ['Read', basename(file)];
      case 'Write': return ['Write', basename(file)];
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return ['Edit', basename(file)];
      case 'Bash': return [input.description || 'Run command', input.description ? '' : String(input.command || '').split('\n')[0].slice(0, 80)];
      case 'BashOutput': return ['Read command output', ''];
      case 'KillShell': case 'KillBash': return ['Stop background command', ''];
      case 'Glob': return ['Find files', input.pattern || ''];
      case 'Grep': return ['Search', input.pattern || ''];
      case 'LS': return ['List', basename(file) || '/'];
      case 'WebFetch': { let h = input.url || ''; try { h = new URL(input.url).host; } catch { /* keep raw */ } return ['Fetch', h]; }
      case 'WebSearch': return ['Search the web', input.query || ''];
      case 'Task': case 'Agent': return ['Agent', input.description || input.subagent_type || ''];
      case 'Skill': return ['Skill', input.skill || input.command || ''];
      case 'ExitPlanMode': return ['Present plan', ''];
      case 'AskUserQuestion': return ['Ask a question', ''];
      default: {
        const mcp = name.match(/^mcp__(.+?)__(.+)$/);
        return mcp ? [mcp[1], mcp[2]] : [name, ''];
      }
    }
  }

  function toolInputView(name, input = {}) {
    const frag = document.createDocumentFragment();
    if (name === 'Bash') frag.append(codeBlock(String(input.command || ''), 'shell'));
    else if (name === 'Edit') frag.append(el('div', { class: 'label', text: input.file_path || '' }), diffView(input.old_string, input.new_string));
    else if (name === 'MultiEdit') {
      frag.append(el('div', { class: 'label', text: input.file_path || '' }));
      for (const e of input.edits || []) frag.append(diffView(e.old_string, e.new_string));
    } else if (name === 'Write') {
      frag.append(el('div', { class: 'label', text: input.file_path || '' }), codeBlock(String(input.content || ''), basename(input.file_path).split('.').pop()));
    } else if (name === 'Read' || name === 'LS') frag.append(el('div', { class: 'label', text: input.file_path || input.path || '' }));
    else frag.append(codeBlock(JSON.stringify(input, null, 2), 'json'));
    return frag;
  }

  function addToolRow(block, before) {
    const [verb, target] = describeTool(block.name, block.input);
    const stateEl = el('span', { class: 'row-state busy' });
    const resultBox = el('div');
    const row = el('details', { class: 'row tool' },
      el('summary', null, icon(ICON.chev, 'chev'),
        el('span', { class: 'row-label' }, el('b', { text: verb }), target ? ' ' : null, target ? el('span', { text: target }) : null),
        stateEl),
      el('div', { class: 'row-body' }, toolInputView(block.name, block.input), resultBox));
    place(row, before);
    state.tools.set(block.id, { stateEl, resultBox, name: block.name });
  }

  function resultText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }

  function settleTool(id, content, isError) {
    const t = state.tools.get(id);
    if (!t) return;
    t.stateEl.className = 'row-state ' + (isError ? 'err' : 'ok');
    t.stateEl.replaceChildren(icon(isError ? ICON.cross : ICON.check));
    const text = resultText(content).trim();
    if (text && !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(t.name) || (text && isError)) {
      t.resultBox.replaceChildren(el('div', { class: 'label', text: isError ? 'Error' : 'Result' }), codeBlock(text, isError ? 'error' : 'output'));
    }
  }

  function settleOpenTools() {
    for (const t of state.tools.values()) {
      if (t.stateEl.classList.contains('busy')) t.stateEl.className = 'row-state';
    }
  }

  function renderTodos(todos, before) {
    state.todosEl?.remove();
    const list = el('ul', { class: 'todos', 'aria-label': 'Claude\u2019s to-do list' },
      (todos || []).map((t) => el('li', { class: t.status, text: t.status === 'in_progress' ? t.activeForm || t.content : t.content })));
    state.todosEl = list;
    place(list, before);
  }

  // ------------------------------------------------------------ transcript
  function nearBottom() {
    const s = refs.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }
  function stick(force) {
    if (force || stick.wanted) requestAnimationFrame(() => (refs.scroller.scrollTop = refs.scroller.scrollHeight));
  }
  function place(node, before) {
    stick.wanted = nearBottom();
    if (before && before.parentNode === refs.transcript) refs.transcript.insertBefore(node, before);
    else refs.transcript.append(node);
    stick();
  }

  function resetTranscript() {
    refs.transcript.replaceChildren();
    state.tools.clear();
    state.drafts.clear();
    state.todosEl = null;
    state.approvals = [];
    renderApprovals();
  }

  function addUser(text, imageCount) {
    const bubble = el('div', { class: 'bubble' });
    if (imageCount) bubble.append(el('span', { class: 'img-note', text: imageCount === 1 ? '1 image attached' : `${imageCount} images attached` }));
    bubble.append(text || '');
    place(el('div', { class: 'turn-user' }, bubble));
    stick(true);
  }

  function addProse(text, before) {
    if (!text || !text.trim()) return;
    place(el('div', { class: 'prose' }, md(text)), before);
  }

  function addThought(text, before) {
    if (!text || !text.trim()) return;
    place(el('details', { class: 'row' },
      el('summary', null, icon(ICON.chev, 'chev'), el('span', { class: 'row-label', text: 'Thought process' })),
      el('div', { class: 'row-body' }, el('div', { class: 'thought', text: text.trim() }))), before);
  }

  function addNotice(text, isErr) { place(el('div', { class: 'notice' + (isErr ? ' err' : ''), text })); }
  function addDivider(text) { place(el('div', { class: 'divider', text })); }

  const META_USER = /^\s*(<[a-z-]+>|Caveat: The messages below|\[Request interrupted)/i;

  /** Renders one SDK-shaped message. `history` = loaded from disk rather than streamed. */
  function applySdkMessage(m, history) {
    if (m.parent_tool_use_id) return;
    const content = m.message?.content;

    if (m.type === 'assistant') {
      const anchor = firstActiveDraft();
      clearStoppedDrafts();
      for (const block of Array.isArray(content) ? content : [{ type: 'text', text: content }]) {
        if (block.type === 'text') addProse(block.text, anchor);
        else if (block.type === 'thinking') addThought(block.thinking, anchor);
        else if (block.type === 'tool_use') {
          if (block.name === 'TodoWrite') renderTodos(block.input?.todos, anchor);
          else addToolRow(block, anchor);
        }
      }
      return;
    }

    if (m.type === 'user') {
      if (typeof content === 'string') {
        if (history && !META_USER.test(content)) addUser(content, 0);
        return;
      }
      let text = ''; let images = 0;
      for (const block of content || []) {
        if (block.type === 'tool_result') settleTool(block.tool_use_id, block.content, block.is_error);
        else if (block.type === 'text') text += (text ? '\n' : '') + block.text;
        else if (block.type === 'image') images++;
      }
      if (history && (text || images) && !META_USER.test(text)) addUser(text, images);
    }
  }

  // Streaming drafts: text appears token by token, then the finished
  // assistant message replaces the draft in the same place.
  function firstActiveDraft() {
    for (const d of state.drafts.values()) if (!d.stopped && d.el.parentNode) return d.el;
    return null;
  }
  function clearStoppedDrafts() {
    for (const [k, d] of state.drafts) if (d.stopped) { d.el.remove(); state.drafts.delete(k); }
  }
  function clearAllDrafts() {
    for (const d of state.drafts.values()) d.el.remove();
    state.drafts.clear();
  }

  function applyStream(ev) {
    if (ev.type === 'message_start') return clearAllDrafts();
    if (ev.type === 'content_block_start') {
      if (ev.block.type === 'text') {
        const node = el('div', { class: 'prose draft' });
        state.drafts.set(ev.index, { kind: 'text', text: '', el: node, stopped: false, dirty: false });
        place(node);
      } else if (ev.block.type === 'thinking') {
        const node = el('div', { class: 'row' }, el('div', { class: 'row-head' }, el('span', { class: 'row-label', text: 'Thinking' }), el('span', { class: 'row-state busy' })));
        state.drafts.set(ev.index, { kind: 'thinking', text: '', el: node, stopped: false });
        place(node);
      }
      return;
    }
    const d = state.drafts.get(ev.index);
    if (!d) return;
    if (ev.type === 'content_block_delta' && d.kind === 'text' && ev.text) {
      d.text += ev.text;
      if (!d.dirty) {
        d.dirty = true;
        requestAnimationFrame(() => {
          d.dirty = false;
          if (!d.el.parentNode) return;
          stick.wanted = nearBottom();
          d.el.replaceChildren(md(d.text));
          stick();
        });
      }
    } else if (ev.type === 'content_block_stop') {
      d.stopped = true;
      d.el.classList.remove('draft');
    }
  }

  function applyEvent(ev) {
    switch (ev.k) {
      case 'stream': return applyStream(ev.event);
      case 'user': return addUser(ev.text, ev.images);
      case 'sdk': return applySdkMessage(ev.m, false);
      case 'init':
        state.current.sessionId = ev.sessionId;
        if (ev.cwd) state.current.cwd = ev.cwd;
        return renderHeader();
      case 'mode': refs.mode.value = ev.mode; return;
      case 'compact': return addDivider('Earlier conversation summarised to free up context');
      case 'permission': state.approvals.push(ev); return renderApprovals();
      case 'permission_resolved':
        state.approvals = state.approvals.filter((a) => a.requestId !== ev.requestId);
        return renderApprovals();
      case 'result': {
        clearAllDrafts();
        settleOpenTools();
        // Claude Code usually says the error itself as its last message; don't repeat it.
        const lastProse = [...refs.transcript.querySelectorAll('.prose')].pop()?.textContent.trim();
        if (ev.isError && (!ev.text || ev.text.trim() !== lastProse)) addNotice(ev.text || 'Claude stopped with an error.', true);
        else if (ev.subtype && ev.subtype !== 'success') addNotice(`Claude stopped early (${ev.subtype.replace(/_/g, ' ')}).`, false);
        const bits = [];
        if (ev.durationMs) bits.push(ev.durationMs < 90000 ? `${Math.max(1, Math.round(ev.durationMs / 1000))}s` : `${Math.round(ev.durationMs / 60000)} min`);
        if (ev.turns > 1) bits.push(`${ev.turns} steps`);
        if (ev.costUsd > 0.005) bits.push(`≈ $${ev.costUsd.toFixed(2)} at API rates`);
        if (bits.length) place(el('div', { class: 'turn-meta', text: bits.join(', ') }));
        loadSessions();
        return;
      }
      case 'error': clearAllDrafts(); settleOpenTools(); return addNotice(ev.message, true);
      case 'closed':
        clearAllDrafts();
        settleOpenTools();
        if (state.current.kind === 'live') {
          state.current = { ...state.current, kind: state.current.sessionId ? 'disk' : 'new', liveId: null };
          if (ev.reason === 'idle' || ev.reason === 'evicted') addDivider('Session paused. Your next message resumes it.');
        }
        return syncControls();
      default: return;
    }
  }

  // -------------------------------------------------------------- approvals
  function permissionTitle(a) {
    if (a.title) return a.title;
    const f = basename(a.input?.file_path);
    switch (a.toolName) {
      case 'Bash': return 'Allow Claude to run this command?';
      case 'Edit': case 'MultiEdit': return `Allow Claude to edit ${f}?`;
      case 'Write': return `Allow Claude to write ${f}?`;
      case 'Read': return `Allow Claude to read ${f}?`;
      case 'WebFetch': return 'Allow Claude to fetch this page?';
      default: return `Allow Claude to use ${describeTool(a.toolName, a.input).filter(Boolean).join(' ')}?`;
    }
  }

  function answer(a, decision) {
    sendWs({ type: 'permission', liveId: state.current.liveId, requestId: a.requestId, decision });
    state.approvals = state.approvals.filter((x) => x.requestId !== a.requestId);
    renderApprovals();
  }

  function renderApprovals() {
    refs.approvals.replaceChildren();
    const a = state.approvals[0];
    if (!a) return;
    const card = el('div', { class: 'perm', role: 'group', 'aria-label': 'Claude needs your approval' });
    if (state.approvals.length > 1) card.append(el('p', { class: 'perm-more', text: `${state.approvals.length - 1} more waiting after this one` }));

    if (a.toolName === 'AskUserQuestion') renderQuestions(card, a);
    else if (a.toolName === 'ExitPlanMode') {
      card.append(el('h3', { text: 'Start on this plan?' }), el('div', { class: 'plan prose' }, md(a.input?.plan || '')),
        el('div', { class: 'perm-actions' },
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', type: 'button', text: 'Keep planning', onclick: () => answer(a, { behavior: 'deny', message: 'Keep refining the plan; do not start yet.' }) }),
          el('button', { class: 'btn primary', type: 'button', text: 'Approve plan', onclick: () => answer(a, { behavior: 'allow' }) })));
    } else {
      const note = el('input', { type: 'text', placeholder: 'Or tell Claude what to do instead', 'aria-label': 'Message to send with Deny' });
      const deny = () => answer(a, { behavior: 'deny', message: note.value });
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && note.value.trim()) deny(); });
      const sub = [a.description, a.reason, a.blockedPath ? `Path: ${a.blockedPath}` : null, a.subagent ? 'Requested by a sub-agent' : null].filter(Boolean).join(' ');
      card.append(el('h3', { text: permissionTitle(a) }),
        sub ? el('p', { class: 'sub', text: sub }) : null,
        el('div', { class: 'detail' }, toolInputView(a.toolName, a.input)),
        el('div', { class: 'perm-actions' },
          note,
          el('button', { class: 'btn', type: 'button', text: 'Deny', onclick: deny }),
          a.canAlways ? el('button', { class: 'btn', type: 'button', text: 'Always allow', title: a.alwaysLabel ? `Adds a rule: ${a.alwaysLabel}` : null, onclick: () => answer(a, { behavior: 'always' }) }) : null,
          el('button', { class: 'btn primary', type: 'button', text: 'Allow once', onclick: () => answer(a, { behavior: 'allow' }) })));
    }
    refs.approvals.append(card);
    stick(true);
  }

  function renderQuestions(card, a) {
    const questions = a.input?.questions || [];
    card.append(el('h3', { text: questions.length === 1 ? 'Claude has a question' : 'Claude has a few questions' }));
    const form = el('div');
    questions.forEach((q, qi) => {
      const group = el('fieldset', { class: 'question' }, el('legend', { text: q.question }));
      (q.options || []).forEach((opt, oi) => {
        group.append(el('label', { class: 'option' },
          el('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `q${qi}`, value: opt.label, 'data-q': qi, id: `q${qi}o${oi}` }),
          el('span', null, opt.label, opt.description ? el('small', { text: opt.description }) : null)));
      });
      group.append(el('input', { class: 'option-other', type: 'text', placeholder: 'Something else', 'data-other': qi, 'aria-label': `Your own answer to: ${q.question}` }));
      form.append(group);
    });
    const submit = () => {
      const answers = {};
      questions.forEach((q, qi) => {
        const other = form.querySelector(`[data-other="${qi}"]`).value.trim();
        const picked = [...form.querySelectorAll(`input[data-q="${qi}"]:checked`)].map((i) => i.value);
        answers[q.question] = other || picked.join(', ');
      });
      if (Object.values(answers).some((v) => !v)) return toast('Pick an option or type your own answer for each question.');
      answer(a, { behavior: 'allow', answers });
    };
    card.append(form, el('div', { class: 'perm-actions' },
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Skip', onclick: () => answer(a, { behavior: 'deny', message: 'The user skipped the question. Use your best judgement or ask in plain text.' }) }),
      el('button', { class: 'btn primary', type: 'button', text: 'Send answers', onclick: submit })));
  }

  // ---------------------------------------------------------------- sidebar
  function liveFor(sessionId) { return sessionId ? state.live.find((l) => l.sessionId === sessionId) : null; }
  function currentLive() { return state.current.liveId ? state.live.find((l) => l.liveId === state.current.liveId) : null; }

  function renderSidebar() {
    const items = state.sessions.map((s) => ({ ...s, live: liveFor(s.sessionId) }));
    for (const l of state.live) {
      if (!items.some((i) => i.live === l)) items.unshift({ sessionId: l.sessionId, title: l.title || 'New session', cwd: l.cwd, lastModified: l.lastActivity, live: l });
    }
    const day = 86400000;
    const midnight = new Date().setHours(0, 0, 0, 0);
    const groups = [['Today', midnight], ['Yesterday', midnight - day], ['Previous 7 days', midnight - 7 * day], ['Older', -Infinity]];
    refs.list.replaceChildren();
    if (!items.length) {
      refs.list.append(el('p', { class: 'session-empty', text: 'Sessions you start show up here, and stay after a restart.' }));
      return;
    }
    let cursor = 0;
    items.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    for (const [label, from] of groups) {
      const bucket = [];
      while (cursor < items.length && (items[cursor].lastModified || 0) >= from) bucket.push(items[cursor++]);
      if (!bucket.length) continue;
      refs.list.append(el('div', { class: 'group-label', text: label }));
      for (const s of bucket) {
        const active = (s.live && s.live.liveId === state.current.liveId) || (s.sessionId && s.sessionId === state.current.sessionId);
        const status = s.live?.status;
        refs.list.append(el('button', {
          class: 'session', type: 'button', 'aria-current': active ? 'true' : null, title: s.cwd || null,
          onclick: () => openSession(s),
        },
        el('span', { class: 'session-title', text: s.title }),
        el('span', { class: 'session-dot ' + (status === 'running' || status === 'starting' ? 'running' : status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : ''),
          title: status === 'waiting' ? 'Waiting for your approval' : status === 'running' ? 'Working' : null })));
      }
    }
  }

  async function loadSessions() {
    try { state.sessions = await api('sessions'); renderSidebar(); } catch { /* sidebar keeps its last state */ }
  }

  // ------------------------------------------------------------ navigation
  function newSession() {
    state.current = { kind: 'new', liveId: null, sessionId: null, cwd: state.config?.defaultCwd || null, title: null, loading: false };
    state.lastSeq = 0;
    resetTranscript();
    renderWelcome();
    renderHeader(); syncControls(); renderSidebar(); closeNav();
    refs.input.focus();
  }

  async function openSession(s) {
    closeNav();
    const liveEntry = s.live || liveFor(s.sessionId);
    state.current = { kind: liveEntry ? 'live' : 'disk', liveId: liveEntry?.liveId || null, sessionId: s.sessionId, cwd: s.cwd, title: s.title, loading: true };
    state.lastSeq = 0;
    resetTranscript();
    refs.welcome.hidden = true;
    renderHeader(); syncControls(); renderSidebar();

    const opening = state.current;
    try {
      // For a resumed session the live log only holds what happened since the
      // resume, so the earlier part comes from disk, capped where the log starts.
      const needHistory = s.sessionId && (!liveEntry || liveEntry.resumed);
      if (needHistory && !(liveEntry && liveEntry.historyCount === 0)) {
        const q = liveEntry ? `?limit=${liveEntry.historyCount}` : '';
        const data = await api(`sessions/${s.sessionId}${q}`);
        if (state.current !== opening) return;
        for (const m of data.messages) applySdkMessage(m, true);
        settleOpenTools();
      }
      if (liveEntry) sendWs({ type: 'attach', liveId: liveEntry.liveId, since: 0 });
      else opening.loading = false;
    } catch (err) {
      opening.loading = false;
      addNotice(`Could not load this session: ${err.message}`, true);
    }
    stick(true);
  }

  function renderHeader() {
    const l = currentLive();
    refs.title.textContent = state.current.title || l?.title || 'New session';
    refs.titlePath.textContent = state.current.kind === 'new' ? '' : state.current.cwd || '';
    refs.folderLabel.textContent = labelForPath(state.current.cwd || state.config?.defaultCwd);
    document.title = `${refs.title.textContent} - Claude Code`;
  }

  function labelForPath(p) {
    if (!p) return 'Folder';
    const root = state.config?.roots.find((r) => r.path === p);
    return root ? root.label : basename(p);
  }

  function renderWelcome() {
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
          el('li', null, 'Copy the token it prints. In Home Assistant, open this add-on\u2019s Configuration tab and paste it into \u201cClaude subscription token\u201d. An Anthropic API key works there too.'),
          el('li', null, 'Save, restart the add-on, and reload this page.')));
      return;
    }
    w.className = 'welcome';
    const starters = [
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

  // --------------------------------------------------------------- composer
  function autosize() {
    const t = refs.input;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  function syncControls() {
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

  function submit() {
    const text = refs.input.value.trim();
    if ((!text && !state.images.length) || refs.send.disabled) return;
    const images = state.images.map(({ mediaType, data }) => ({ mediaType, data }));

    if (state.current.kind === 'live' && currentLive()) {
      sendWs({ type: 'send', liveId: state.current.liveId, text, images });
    } else {
      const reqId = Math.random().toString(36).slice(2);
      state.pendingStart = { reqId, text, target: state.current };
      sendWs({
        type: 'start', reqId, text, images,
        cwd: state.current.cwd || state.config.defaultCwd,
        mode: state.draftMode, model: state.draftModel,
        resume: state.current.kind === 'disk' ? state.current.sessionId : undefined,
      });
      refs.welcome.hidden = true;
      if (!state.current.title) state.current.title = text.slice(0, 80);
      renderHeader();
    }
    refs.input.value = '';
    state.images = [];
    renderAttachments(); autosize(); syncControls();
  }

  function renderAttachments() {
    refs.attachments.hidden = !state.images.length;
    refs.attachments.replaceChildren(...state.images.map((img, i) => el('div', { class: 'attachment' },
      el('img', { src: img.url, alt: img.name || 'Attached image' }),
      el('button', { type: 'button', 'aria-label': 'Remove image', text: '×', onclick: () => { state.images.splice(i, 1); renderAttachments(); syncControls(); } }))));
  }

  function addFiles(files) {
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

  // ---------------------------------------------------------- folder picker
  async function openFolderPicker(target) {
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
      for (const r of state.config.roots) {
        list.append(el('button', { class: 'pop-item', type: 'button', onclick: () => openFolderPicker(r.path) }, icon(ICON.folder), r.label, el('small', { text: r.path })));
      }
      return;
    }
    try {
      const data = await api('dirs?path=' + encodeURIComponent(target));
      list.append(el('button', { class: 'pop-item', type: 'button', onclick: () => openFolderPicker(data.parent) }, icon(ICON.up), data.parent ? 'Up one level' : 'All folders'));
      for (const d of data.dirs) list.append(el('button', { class: 'pop-item', type: 'button', onclick: () => openFolderPicker(data.path + '/' + d) }, icon(ICON.folder), d));
      if (!data.dirs.length) list.append(el('p', { class: 'session-empty', text: 'No folders inside this one.' }));
      foot.append(el('button', { class: 'btn primary', type: 'button', text: 'Work in this folder', onclick: () => { state.current.cwd = data.path; pop.hidden = true; renderHeader(); } }));
    } catch (err) {
      list.append(el('p', { class: 'session-empty', text: err.message }));
    }
  }

  // ------------------------------------------------------------------ misc
  let toastTimer;
  function toast(text) {
    refs.toast.textContent = text;
    refs.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (refs.toast.hidden = true), 5200);
  }
  function closeNav() { refs.app.classList.remove('nav-open'); }

  function fillSelects() {
    refs.mode.replaceChildren(...(state.config?.modes || ['default']).map((m) => new Option(MODE_LABEL[m] || m, m)));
    const models = state.models || [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }];
    const def = state.config?.defaultModel;
    refs.model.replaceChildren(new Option(def ? `Default (${def})` : 'Default model', ''),
      ...models.filter((m) => m.value && m.value !== 'default').map((m) => new Option(m.name || m.value, m.value)));
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  // -------------------------------------------------------------- websocket
  let retry = 0;
  function sendWs(payload) {
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(payload));
    else toast('Not connected to the add-on. Trying again.');
  }

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws`;
    const ws = new WebSocket(url);
    state.ws = ws;
    refs.conn.className = 'conn'; refs.connText.textContent = 'Connecting';

    ws.onopen = () => { retry = 0; };
    ws.onclose = () => {
      refs.conn.className = 'conn down'; refs.connText.textContent = 'Reconnecting';
      syncControls();
      setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      onServer(msg);
    };
  }

  function onServer(msg) {
    switch (msg.type) {
      case 'hello': {
        const first = !state.config;
        state.config = msg.state; state.live = msg.live; state.models = msg.state.models || state.models;
        refs.conn.className = 'conn ok'; refs.connText.textContent = `Connected, v${msg.state.version}`;
        refs.fineprint.hidden = !msg.state.authConfigured;
        fillSelects();
        if (first) {
          state.draftMode = msg.state.defaultMode;
          newSession();
          loadSessions();
        } else if (state.current.kind === 'live') {
          // Reconnected: catch up on what was missed, or fall back to the saved copy.
          if (currentLive()) sendWs({ type: 'attach', liveId: state.current.liveId, since: state.lastSeq });
          else state.current = { ...state.current, kind: state.current.sessionId ? 'disk' : 'new', liveId: null };
        }
        renderSidebar(); syncControls();
        return;
      }
      case 'live':
        state.live = msg.live;
        renderSidebar(); renderHeader(); syncControls();
        return;
      case 'models': state.models = msg.models; fillSelects(); syncControls(); return;
      case 'started': {
        const p = state.pendingStart;
        if (!p || p.reqId !== msg.reqId) return;
        state.pendingStart = null;
        if (state.current !== p.target) return;
        if (!state.live.some((l) => l.liveId === msg.session.liveId)) state.live.push(msg.session);
        state.current = { ...state.current, kind: 'live', liveId: msg.session.liveId, sessionId: msg.session.sessionId, cwd: msg.session.cwd, loading: false };
        state.lastSeq = 0;
        renderHeader(); renderSidebar(); syncControls();
        return;
      }
      case 'replay':
        if (msg.liveId !== state.current.liveId) return;
        for (const entry of msg.entries) if (entry.seq > state.lastSeq) { state.lastSeq = entry.seq; applyEvent(entry.ev); }
        state.current.loading = false;
        syncControls(); stick(true);
        return;
      case 'event':
        if (msg.liveId !== state.current.liveId || state.current.loading) return;
        if (msg.seq != null) { if (msg.seq <= state.lastSeq) return; state.lastSeq = msg.seq; }
        applyEvent(msg.ev);
        return;
      case 'error': {
        const p = state.pendingStart;
        if (p && p.reqId === msg.reqId) {
          state.pendingStart = null;
          if (!refs.input.value) { refs.input.value = p.text; autosize(); }
          if (state.current.kind === 'new' && !refs.transcript.childElementCount) refs.welcome.hidden = false;
        }
        toast(msg.message);
        syncControls();
        return;
      }
      default: return;
    }
  }

  // ----------------------------------------------------------------- wiring
  refs.input.addEventListener('input', () => { autosize(); syncControls(); });
  refs.input.addEventListener('keydown', (e) => {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); submit(); }
  });
  refs.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  refs.send.addEventListener('click', submit);
  refs.stop.addEventListener('click', () => sendWs({ type: 'interrupt', liveId: state.current.liveId }));
  $('attachBtn').addEventListener('click', () => refs.file.click());
  refs.file.addEventListener('change', () => { addFiles(refs.file.files); refs.file.value = ''; });
  $('composer').addEventListener('dragover', (e) => e.preventDefault());
  $('composer').addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer?.files || []); });

  refs.mode.addEventListener('change', () => {
    if (currentLive()) sendWs({ type: 'set_mode', liveId: state.current.liveId, mode: refs.mode.value });
    else state.draftMode = refs.mode.value;
  });
  refs.model.addEventListener('change', () => {
    if (currentLive()) sendWs({ type: 'set_model', liveId: state.current.liveId, model: refs.model.value });
    state.draftModel = refs.model.value;
  });

  $('newSession').addEventListener('click', newSession);
  $('openSidebar').addEventListener('click', () => refs.app.classList.add('nav-open'));
  $('closeSidebar').addEventListener('click', closeNav);
  $('scrim').addEventListener('click', closeNav);
  refs.folderChip.addEventListener('click', (e) => { e.stopPropagation(); refs.popover.hidden ? openFolderPicker(null) : (refs.popover.hidden = true); });
  document.addEventListener('click', (e) => { if (!refs.popover.hidden && !refs.popover.contains(e.target)) refs.popover.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { refs.popover.hidden = true; closeNav(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newSession(); }
  });

  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme')
      ? document.documentElement.getAttribute('data-theme') === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('cc-theme', next); } catch { /* private mode */ }
  });
  try { applyTheme(localStorage.getItem('cc-theme')); } catch { /* private mode */ }

  window.__panel = { md, applyEvent, applySdkMessage, onServer, state };
  connect();
})();
