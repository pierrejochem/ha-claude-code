// Panel-shell chrome: the toast, the mobile nav, and the light/dark theme
// attribute. Ported from public/app.js:811-818 and :828-831.

import { refs } from './refs';

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string): void {
  refs.toast.textContent = text;
  refs.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (refs.toast.hidden = true), 5200);
}

export function closeNav(): void {
  refs.app.classList.remove('nav-open');
}

export function applyTheme(theme: string | null): void {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
