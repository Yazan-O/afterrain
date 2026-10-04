// Collects what a viewer can read on the page, in one pass inside the browser.
// A text run counts as visible when it lays out in a box larger than 1 x 1 px, its element's computed
// visibility is "visible", the product of the opacities of it and its ancestors is above 0.1, and no
// clipping ancestor is 1 px or smaller (screen-reader-only text). Canvas words come from window.__sayrCanvasWords.
import type { Page } from '@playwright/test';

export interface TextRun {
  readonly text: string;
  readonly source: 'dom' | 'pseudo' | 'field' | 'canvas';
  /** A short description of the element, for failure messages. */
  readonly where: string;
  /** data-num key of the closest [data-num] ancestor (or the canvas entry's num). */
  readonly num: string | null;
  readonly fmt: string | null;
  /** Full text of that [data-num] element, compared whole against the formatted value. */
  readonly numText: string | null;
  /** Identifies the [data-num] element so one element is checked once. */
  readonly numId: string | null;
  readonly time: boolean;
  readonly unit: string | null;
  /** data-src of the closest [data-src] ancestor ("<file>#<json pointer>"), or the canvas entry's src. */
  readonly src: string | null;
  /** Full text of that [data-src] element, an id so one element is checked once, and its data-fmt. */
  readonly srcText: string | null;
  readonly srcId: string | null;
  readonly srcFmt: string | null;
  /** Inside a [data-code] region (the x-ray's typeset FHIR resource): exempt from the word budget only. */
  readonly code: boolean;
}

export interface PageText {
  readonly visible: TextRun[];
  /** Every string on the page, shown or not: text, title, alt, aria-label, placeholder, canvas entries. */
  readonly everything: string[];
}

export const MIN_OPACITY = 0.1;

export async function collectText(page: Page): Promise<PageText> {
  return page.evaluate((minOpacity) => {
    const visible: TextRun[] = [];
    const everything: string[] = [document.title];
    const ids = new WeakMap<Element, string>();
    let nextId = 0;
    const idOf = (el: Element): string => {
      let id = ids.get(el);
      if (!id) ids.set(el, (id = `n${nextId++}`));
      return id;
    };
    const describe = (el: Element): string => {
      const cls = el.getAttribute('class');
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}>`;
    };
    // Visible means: computed visibility "visible", combined opacity above the threshold, and no clipping
    // ancestor (overflow, clip or clip-path) squeezed to 1 px or less, which is how screen-reader-only text hides.
    const shown = (el: Element): boolean => {
      if (getComputedStyle(el).visibility !== 'visible') return false;
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        o *= Number.parseFloat(cs.opacity);
        const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clip !== 'auto' || cs.clipPath !== 'none';
        const r = e.getBoundingClientRect();
        if (clips && (r.width <= 1 || r.height <= 1)) return false;
      }
      return o > minOpacity;
    };
    const bigEnough = (rects: DOMRectList | DOMRect[]): boolean => [...rects].some((r) => r.width > 1 && r.height > 1);
    const marks = (el: Element) => {
      const numEl = el.closest('[data-num]');
      return {
        num: numEl?.getAttribute('data-num') ?? null,
        fmt: numEl?.getAttribute('data-fmt') ?? null,
        numText: numEl ? (numEl.textContent ?? '').trim() : null,
        numId: numEl ? idOf(numEl) : null,
        time: el.closest('[data-time]') !== null,
        unit: el.closest('[data-unit]') ? (el.closest('[data-unit]')!.textContent ?? '').trim() : null,
        src: el.closest('[data-src]')?.getAttribute('data-src') ?? null,
        srcText: el.closest('[data-src]') ? (el.closest('[data-src]')!.textContent ?? '').trim() : null,
        srcId: el.closest('[data-src]') ? idOf(el.closest('[data-src]')!) : null,
        srcFmt: el.closest('[data-src]')?.getAttribute('data-fmt') ?? null,
        code: el.closest('[data-code]') !== null,
      };
    };
    const skip = (el: Element): boolean => el.closest('script, style, noscript, template, head') !== null;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      const el = n.parentElement;
      if (!el || skip(el) || !text.trim()) continue;
      everything.push(text);
      const range = document.createRange();
      range.selectNodeContents(n);
      if (!bigEnough(range.getClientRects()) || !shown(el)) continue;
      visible.push({ text, source: 'dom', where: describe(el), ...marks(el) });
    }

    for (const el of document.body.querySelectorAll('*')) {
      if (skip(el)) continue;
      for (const attr of ['alt', 'title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v) everything.push(v);
      }
      for (const pseudo of ['::before', '::after'] as const) {
        const content = getComputedStyle(el, pseudo).content;
        const m = /^"(.*)"$/.exec(content);
        if (!m || !m[1]!.trim()) continue;
        everything.push(m[1]!);
        if (bigEnough([el.getBoundingClientRect()]) && shown(el)) visible.push({ text: m[1]!, source: 'pseudo', where: `${describe(el)}${pseudo}`, ...marks(el) });
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el instanceof HTMLInputElement && ['hidden', 'checkbox', 'radio', 'range', 'color', 'file'].includes(el.type)) continue;
        const text = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? '') : el.value || el.getAttribute('placeholder') || '';
        if (text.trim() && bigEnough([el.getBoundingClientRect()]) && shown(el)) visible.push({ text, source: 'field', where: describe(el), ...marks(el) });
      }
    }

    for (const [id, entry] of Object.entries(window.__sayrCanvasWords ?? {})) {
      everything.push(entry.text);
      visible.push({
        text: entry.text,
        source: 'canvas',
        where: `canvas entry "${id}"`,
        num: entry.num ?? null,
        fmt: entry.fmt ?? null,
        numText: entry.num ? entry.text.trim() : null,
        numId: entry.num ? `canvas:${id}` : null,
        time: entry.time === true,
        unit: null,
        src: entry.src ?? null,
        srcText: entry.src ? entry.text.trim() : null,
        srcId: entry.src ? `canvas:${id}` : null,
        srcFmt: entry.src ? (entry.fmt ?? null) : null,
        code: false,
      });
    }
    return { visible, everything };
  }, MIN_OPACITY);
}

/** Words in a run: whitespace-separated tokens that contain a letter or a digit. */
export const wordsIn = (text: string): string[] => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
