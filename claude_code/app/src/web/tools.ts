// Tool-call description and rendering: the verb/target pair shown on a tool
// row, the body shown when it is expanded, and the plain-text form of a tool
// result. Ported from public/app.js:241-297.

import { basename, el } from './dom';
import { codeBlock } from './markdown';
import { diffView } from './diff';

export interface ToolInput {
  file_path?: string;
  path?: string;
  notebook_path?: string;
  command?: string;
  description?: string;
  pattern?: string;
  url?: string;
  query?: string;
  subagent_type?: string;
  skill?: string;
  plan?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  todos?: TodoItem[];
  questions?: QuestionSpec[];
  [key: string]: unknown;
}

export interface TodoItem {
  content: string;
  activeForm?: string;
  status: string;
}

export interface QuestionSpec {
  question: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

// A tool result's content, when it isn't a plain string, is an array of
// content blocks. This is the narrow view `resultText` reads from each one.
interface ResultContentBlock {
  type: string;
  text?: string;
}

export function asToolInput(input: unknown): ToolInput {
  return input && typeof input === 'object' ? (input as ToolInput) : {};
}

// ------------------------------------------------------------- tool rows
export function describeTool(name: string, input: ToolInput = {}): [string, string] {
  const file = input.file_path || input.path || input.notebook_path;
  switch (name) {
    case 'Read':
      return ['Read', basename(file)];
    case 'Write':
      return ['Write', basename(file)];
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ['Edit', basename(file)];
    case 'Bash':
      return [
        input.description || 'Run command',
        input.description ? '' : String(input.command || '').split('\n')[0].slice(0, 80),
      ];
    case 'BashOutput':
      return ['Read command output', ''];
    case 'KillShell':
    case 'KillBash':
      return ['Stop background command', ''];
    case 'Glob':
      return ['Find files', input.pattern || ''];
    case 'Grep':
      return ['Search', input.pattern || ''];
    case 'LS':
      return ['List', basename(file) || '/'];
    case 'WebFetch': {
      let h = input.url || '';
      try {
        h = new URL(input.url || '').host;
      } catch {
        /* keep raw */
      }
      return ['Fetch', h];
    }
    case 'WebSearch':
      return ['Search the web', input.query || ''];
    case 'Task':
    case 'Agent':
      return ['Agent', input.description || input.subagent_type || ''];
    case 'Skill':
      return ['Skill', input.skill || input.command || ''];
    case 'ExitPlanMode':
      return ['Present plan', ''];
    case 'AskUserQuestion':
      return ['Ask a question', ''];
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? [mcp[1], mcp[2]] : [name, ''];
    }
  }
}

export function toolInputView(name: string, input: ToolInput = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (name === 'Bash') frag.append(codeBlock(String(input.command || ''), 'shell'));
  else if (name === 'Edit')
    frag.append(
      el('div', { class: 'label', text: input.file_path || '' }),
      diffView(input.old_string, input.new_string),
    );
  else if (name === 'MultiEdit') {
    frag.append(el('div', { class: 'label', text: input.file_path || '' }));
    for (const e of input.edits || []) frag.append(diffView(e.old_string, e.new_string));
  } else if (name === 'Write') {
    frag.append(
      el('div', { class: 'label', text: input.file_path || '' }),
      codeBlock(String(input.content || ''), basename(input.file_path).split('.').pop()),
    );
  } else if (name === 'Read' || name === 'LS')
    frag.append(el('div', { class: 'label', text: input.file_path || input.path || '' }));
  else frag.append(codeBlock(JSON.stringify(input, null, 2), 'json'));
  return frag;
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ResultContentBlock[])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n');
}
