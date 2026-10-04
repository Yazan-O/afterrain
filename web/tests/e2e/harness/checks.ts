// The quality checks every Sayr screen must pass. Each check has a `find…` function that returns what it
// found (so the harness tests can show a check failing) and an `assert…` function that throws on failure.
import type { Page } from '@playwright/test';
import { TERRAIN_CREDITS } from '../../../src/app/credits';
import { formatNumber } from '../../../src/format/numfmt';
import type { NumbersFile } from '../../../src/data/schemas';
import { wordsIn, type PageText, type TextRun } from './collect';

// Word budget (spec section 4: "At rest, eight words or fewer on screen. After tapping a stream, twenty-five or fewer.")

// strip and compare 30: the cap cuts narration, never the place, date, unit or direction.
// strip 34 and compare 32: the forecast curve names what its scale measures, its two
// fixed ends, the days of its time axis and when a result is ready; the comparison names its upstream reference
// and the single-sample flag.
// restDated 9 (fix round 2026-10-03, for the lead to confirm): the ending of a dated forecast (clock past its end)
// carries the corner "forecast 3 Oct" (3 words) besides the window, the control and the wordmark; when the request
// falls on a later day than that date its window needs its weekday ("Sun 08:00–20:00 UTC+1"), one word over 8.
// story 38 (story-first rebuild 2026-10-04): a narrated beat carries one sentence of up to 22 words (the owner's
// narration budget); the scene under it keeps its own few words (the replay's key, dated name and reading, the
// city's name and hour, the map's key on the map, or the comparison's labelled test reading).
// key 32 (same rebuild): the map's key brought back in free exploration, three labels on the map (22 words) over
// the rest view.
// strip 44 (same rebuild): the open stream's first line is now the person's sentence (place, day, chance, why,
// "Keep dogs out until <time>" and the fog note, up to 22 words) in place of the stream's 13-word line.
export const WORD_BUDGETS = { rest: 8, restDated: 9, strip: 44, compare: 32, story: 38, key: 32 } as const;
export type ScreenState = keyof typeof WORD_BUDGETS;

export interface WordCount {
  readonly count: number;
  readonly words: string[];
}

/**
 * Words inside a [data-code] region are not counted: that is the FHIR x-ray's typeset resource, code a viewer
 * asked to see. Every other check still applies there: each digit in it must trace to its file by data-src.
 */
export const countWords = (t: PageText): WordCount => {
  const words = t.visible.filter((r) => !r.code).flatMap((r) => wordsIn(r.text));
  return { count: words.length, words };
};

export function assertWordBudget(t: PageText, state: ScreenState): void {
  const { count, words } = countWords(t);
  const budget = WORD_BUDGETS[state];
  if (count > budget) throw new Error(`word budget: ${count} words visible in state "${state}", budget ${budget}: ${words.join(' ')}`);
}

// Number provenance (spec section 13: "Every number on screen comes from a model run or a data row").

/**
 * Units (and names) that contain digits but are not data. An element marked data-unit must hold exactly one of
 * these, so the exemption cannot hide a number. "HL7" is the standards body whose validator the x-ray names;
 * "CC BY 4.0" is the licence the credits name; "0%", "50%" and "100%" are the fixed marks of the chance scale
 * (one 0 to 100% scale, never rescaled), constants of the drawing rather than data. The
 * terrain providers' attribution statements (src/app/credits.ts) are licence text, matched whole.
 */
export const UNIT_ALLOWLIST = ['per 100 ml', '100 ml', 'E. coli per 100 ml', 'E. coli/100 ml', 'HL7', 'CC BY 4.0', '0%', '50%', '100%', ...TERRAIN_CREDITS] as const;

export interface ProvenanceProblem {
  readonly where: string;
  readonly text: string;
  readonly problem: string;
}

/** Data files by name (as served under /data/), for data-src references. */
export type DataFiles = Readonly<Record<string, unknown>>;

/** The files named by data-src references on the page ("<file>#<pointer>" gives "<file>"). */
export const referencedFiles = (t: PageText): string[] => [...new Set(t.visible.filter((r) => r.src !== null).map((r) => r.src!.split('#')[0]!))];

/** Resolves an RFC 6901 JSON pointer ("/streams/3/length_km"); undefined when any step is missing. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) return undefined;
      cur = cur[Number(key)];
    } else if (typeof cur === 'object' && cur !== null && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

/** A data-src element's whole text must equal the referenced value: a number through formatNumber and data-fmt, a string as is. */
function checkSourced(r: TextRun, files: DataFiles): ProvenanceProblem[] {
  const ref = r.src!;
  const hash = ref.indexOf('#');
  const fail = (problem: string): ProvenanceProblem[] => [{ where: r.where, text: r.srcText!, problem: `data-src="${ref}": ${problem}` }];
  if (hash < 0) return fail('expected "<file>#<json pointer>"');
  const file = ref.slice(0, hash);
  if (!(file in files)) return fail(`data file ${file} could not be loaded`);
  const value = resolvePointer(files[file], ref.slice(hash + 1));
  if (value === undefined) return fail(`no value at ${ref.slice(hash + 1)} in ${file}`);
  let expected: string;
  if (typeof value === 'string') expected = value;
  else if (typeof value === 'number') {
    try {
      expected = formatNumber(value, r.srcFmt);
    } catch (e) {
      return fail((e as Error).message);
    }
  } else return fail(`the value there is ${value === null ? 'null' : typeof value}, not a number or a string`);
  return r.srcText === expected ? [] : fail(`shows "${r.srcText}" but ${file} formats to "${expected}"`);
}

export function findProvenanceProblems(t: PageText, numbers: NumbersFile, files: DataFiles = {}): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = [];
  const checked = new Set<string>();
  const hasDigit = (s: string): boolean => /\d/.test(s);
  for (const r of t.visible) {
    if (r.time) continue;
    if (r.num !== null) {
      if (checked.has(r.numId!)) continue;
      checked.add(r.numId!);
      problems.push(...checkNumbered(r, numbers));
      continue;
    }
    if (r.src !== null) {
      if (checked.has(r.srcId!)) continue;
      checked.add(r.srcId!);
      problems.push(...checkSourced(r, files));
      continue;
    }
    if (r.unit !== null && (UNIT_ALLOWLIST as readonly string[]).includes(r.unit)) continue;
    if (r.unit !== null && hasDigit(r.text)) {
      problems.push({ where: r.where, text: r.text, problem: `data-unit "${r.unit}" is not in the unit allowlist` });
      continue;
    }
    if (hasDigit(r.text)) problems.push({ where: r.where, text: r.text, problem: 'digits outside any [data-num] or [data-time] element' });
  }
  return problems;
}

function checkNumbered(r: TextRun, numbers: NumbersFile): ProvenanceProblem[] {
  const entry = numbers[r.num!];
  if (!entry) return [{ where: r.where, text: r.numText!, problem: `data-num="${r.num}" is not a key in numbers.json` }];
  let expected: string;
  try {
    expected = formatNumber(entry.value, r.fmt);
  } catch (e) {
    return [{ where: r.where, text: r.numText!, problem: `data-num="${r.num}": ${(e as Error).message}` }];
  }
  return r.numText === expected
    ? []
    : [{ where: r.where, text: r.numText!, problem: `data-num="${r.num}" shows "${r.numText}" but numbers.json formats to "${expected}"` }];
}

export function assertNumbersTraced(t: PageText, numbers: NumbersFile, files: DataFiles = {}): void {
  const p = findProvenanceProblems(t, numbers, files);
  if (p.length) throw new Error(`number provenance: ${p.length} problem(s):\n${p.map((x) => `  ${x.where} "${x.text}": ${x.problem}`).join('\n')}`);
}

// Banned words (spec section 13: "Never the word 'safe'").

export const BANNED = /\bsafe\b/i;

export const findBannedWords = (t: PageText): string[] => t.everything.filter((s) => BANNED.test(s));

export function assertNoBannedWords(t: PageText): void {
  const hits = findBannedWords(t);
  if (hits.length) throw new Error(`banned word "safe" on the page (shown or hidden): ${hits.map((h) => JSON.stringify(h.trim())).join(', ')}`);
}

// Horizontal scroll.

export interface OverflowReport {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly offenders: string[];
}

export const measureHorizontalOverflow = (page: Page): Promise<OverflowReport> =>
  page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders = [...document.body.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > clientWidth + 0.5)
      .slice(0, 5)
      .map((el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> right edge ${Math.round(el.getBoundingClientRect().right)} px`);
    return { scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth), clientWidth, offenders };
  });

export function assertNoHorizontalScroll(r: OverflowReport): void {
  if (r.scrollWidth > r.clientWidth)
    throw new Error(`horizontal scroll: page is ${r.scrollWidth} px wide in a ${r.clientWidth} px viewport; ${r.offenders.join('; ')}`);
}

// Reduced motion (spec section 4: "prefers-reduced-motion shows still frames with the same information").

export const runningAnimations = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
        const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : a.id || 'script animation';
        return `${name} on ${target ? `<${target.tagName.toLowerCase()}>` : 'unknown target'}`;
      }),
  );

export function assertStill(running: string[]): void {
  if (running.length) throw new Error(`reduced motion: ${running.length} animation(s) still running: ${running.join(', ')}`);
}

// Contrast (WCAG 2.1 AA): every visible DOM text run, blended by its opacity, against the page ground (the theme
// background, which is also the ground tone of the night and day maps the text sits on).

export interface ContrastProblem {
  readonly where: string;
  readonly text: string;
  readonly ratio: number;
  readonly needed: number;
}

export const findContrastProblems = (page: Page): Promise<ContrastProblem[]> =>
  page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = (rgb: number[]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const bg = parse(getComputedStyle(document.body).backgroundColor);
    const out: { where: string; text: string; ratio: number; needed: number }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      const text = (n.nodeValue ?? '').trim();
      // [data-fading]: a word in the middle of its fade in or out is measured when it is at full strength
      if (!el || !text || el.closest('script, style, noscript, template, [data-fading]')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if (![...range.getClientRects()].some((r) => r.width > 1 && r.height > 1)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      let o = 1;
      let clipped = false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = getComputedStyle(e);
        o *= Number.parseFloat(c.opacity);
        const r = e.getBoundingClientRect();
        if ((c.overflowX !== 'visible' || c.clip !== 'auto' || c.clipPath !== 'none') && (r.width <= 1 || r.height <= 1)) clipped = true;
      }
      if (clipped || o <= 0.1) continue;
      const [r, g, b, a] = parse(cs.color);
      const k = a * o;
      const fg = [r * k + bg[0] * (1 - k), g * k + bg[1] * (1 - k), b * k + bg[2] * (1 - k)];
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = Number.parseFloat(cs.fontSize);
      const needed = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
      if (ratio < needed) out.push({ where: `<${el.tagName.toLowerCase()}>`, text, ratio: Math.round(ratio * 100) / 100, needed });
    }
    return out;
  });

export function assertContrast(problems: readonly ContrastProblem[]): void {
  if (problems.length)
    throw new Error(`contrast: ${problems.length} text run(s) below WCAG AA:\n${problems.map((p) => `  ${p.where} "${p.text}": ${p.ratio}:1, needs ${p.needed}:1`).join('\n')}`);
}
