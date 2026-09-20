// Tiny DOM kit: element construction, inline SVG icons, and a strict
// element lookup by id. Ported from public/app.js:4-38.

export type ElChild = Node | string | number | null | undefined | ElChild[];
export type ElAttrValue = string | number | boolean | null | undefined | ((ev: Event) => void);
export interface ElAttrs {
  [key: string]: ElAttrValue;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs | null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: ElAttrs | null, ...children: ElChild[]): HTMLElement;
export function el(tag: string, attrs?: ElAttrs | null, ...children: ElChild[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v as string;
      else if (k === 'text') node.textContent = String(v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v as EventListener);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  // `children` is meant to nest exactly one level deep (a single array of
  // nodes spliced in among plain children, e.g. from `.map()`), matching
  // what `.flat()` actually removes at runtime; the cast reflects that
  // contract, which `ElChild`'s recursive type can't itself express.
  const flatChildren = children.flat() as Array<Node | string | number | null | undefined>;
  for (const c of flatChildren) {
    if (c == null) continue;
    node.append(typeof c === 'object' ? c : String(c));
  }
  return node;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(d: string, cls?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

export const ICON = {
  chev: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6 6l12 12M18 6L6 18',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  up: 'M12 19V5M6 11l6-6 6 6',
};

export function basename(p: unknown): string {
  return String(p || '').split('/').filter(Boolean).pop() || String(p || '');
}

/**
 * Looks up an element that index.html is expected to ship. Throws instead of
 * returning null: a missing element can only mean a broken template, so this
 * fails loudly at startup rather than throwing later on a property access.
 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id} in index.html`);
  return node as T;
}
