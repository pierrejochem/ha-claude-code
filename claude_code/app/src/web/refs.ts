// Cached lookups for every element the panel touches by id. Ported from
// public/app.js:59-66; each member carries its real element type so later
// tasks get `.value`, `.hidden` and `.files` checked.

import { $ } from './dom';

export const refs = {
  app: $('app'),
  list: $('sessionList'),
  transcript: $('transcript'),
  welcome: $('welcome'),
  scroller: $('scroller'),
  working: $('working'),
  approvals: $('approvals'),
  input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('sendBtn'),
  stop: $<HTMLButtonElement>('stopBtn'),
  title: $('title'),
  titlePath: $('titlePath'),
  folderChip: $<HTMLButtonElement>('folderChip'),
  folderLabel: $('folderLabel'),
  mode: $<HTMLSelectElement>('modeSelect'),
  model: $<HTMLSelectElement>('modelSelect'),
  conn: $('conn'),
  connText: $('connText'),
  popover: $('folderPopover'),
  toast: $('toast'),
  attachments: $('attachments'),
  file: $<HTMLInputElement>('fileInput'),
  fineprint: $('fineprint'),
};
