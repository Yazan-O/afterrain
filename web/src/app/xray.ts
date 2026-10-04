// The FHIR x-ray (spec W8): a number or estimate on screen turns over, in place, to show the OAH-FHIR resource it
// came from, typeset as code (only the key lines, the profile first), with a quiet mark bound to the HL7
// validator's summary. It is the only place code appears.
//
// Reach it by Alt+click, a long press (touch or mouse), the X key (the element in focus, else the largest one on
// screen), or the folded corner that appears on hover. Escape, X or a tap outside turns it back. While a card is
// open the scene recedes and story mode holds. The turn is driven by the app clock.
//
// What can turn over (src/fhir/xrayMap.ts): any element with data-fhir, the replay's sample numbers (by their
// data-src) and the Warleigh Weir label. Every value on the back carries data-src to the served resource file, so
// the number provenance check reads each one against /data/fhir; the code sits in a [data-code] region, which
// the word budget skips. The validator's mark is read from the served summary (fhir/sayr.summary.json) each time a
// card opens: its error count, and a cross instead of the tick when it holds errors or fatal findings.
import type { Loaders } from '../data/loaders';
import type { ReplayKey } from '../data/schemas';
import { isLiveKey, liveRecord } from '../fhir/liveRecords';
import { keyLines, parseSampleSrc, resolveKey, resolveSample, WEIR_REF, type FhirIndex, type Json, type XrayTarget } from '../fhir/xrayMap';
import type { SceneClock } from '../scenes/types';
import { formatNumber } from '../format/numfmt';

const CANDIDATES = '[data-fhir], .rp-arr[data-src], .rp-weir';
const TURN = 0.74; // seconds for a full turn
const HALF = 0.4; // the front is edge-on here
const LONG_PRESS_MS = 480;

export interface XrayDeps {
  readonly clock: SceneClock;
  readonly reducedMotion: boolean;
  readonly data: Loaders;
  /** Base URL of the served data files ("/data/"). */
  readonly base: string;
  /** The element that holds the scenes; it recedes while a card is open. */
  readonly scene: HTMLElement;
  /** Holds the scene on screen still while a card is open (true), and lets it go on (false). */
  readonly pause?: (on: boolean) => void;
}

/** The validator's summary as the FHIR build writes it (sayr/fhir/build/validate/sayr.summary.json). */
interface ValidatorSummary {
  readonly counts: { readonly error: number; readonly fatal: number };
}

export interface Xray {
  isOpen(): boolean;
  /** A card the viewer opened is up (one story mode opened itself does not hold the story). */
  holds(): boolean;
  close(): void;
  /** Turns over the element (or the largest one on screen); resolves true when a card opened. */
  open(el?: HTMLElement | null, opts?: { story?: boolean }): Promise<boolean>;
}

/** One resource on the back of a card, and where each of its values comes from. */
interface Shown {
  readonly ref: string;
  readonly json: Json;
  readonly src: (ptr: string) => string;
}

const smooth = (u: number): number => {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
};
const easeIn = (u: number): number => u * u * u;
const easeOut = (u: number): number => 1 - (1 - u) ** 3;
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Card {
  readonly story: boolean;
  readonly el: HTMLElement;
  readonly back: HTMLElement;
  readonly ghost: HTMLElement | null;
  readonly lines: HTMLElement[];
  p: number;
  dir: 1 | -1;
  last: number;
  readonly focusBack: Element | null;
}

export function installXray(deps: XrayDeps): Xray {
  const layer = document.createElement('div');
  layer.className = 'xr-layer';
  const ear = document.createElement('button');
  ear.type = 'button';
  ear.className = 'xr-ear';
  ear.setAttribute('aria-label', 'Turn over: the FHIR resource behind this (X)');
  ear.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1h12v12z" /><path d="M1 1l12 12" /></svg>';
  ear.hidden = true;
  document.body.append(layer, ear);

  let indexP: Promise<FhirIndex> | null = null;
  const index = (): Promise<FhirIndex> =>
    (indexP ??= fetchJson<FhirIndex>(`${deps.base}fhir/index.json`).catch((e: unknown) => {
      indexP = null;
      throw e;
    }));
  const replays = new Map<string, Promise<{ samples: readonly { time_utc: string }[] }>>();
  const resolved = new WeakMap<Element, { key: string; target: Promise<XrayTarget | null> }>();

  async function fetchJson<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`x-ray: HTTP ${r.status} fetching ${url}`);
    return (await r.json()) as T;
  }

  /**
   * The resources behind an element, from its key as it was when asked (a line that moves on to another place or
   * hour while the index loads keeps the resource it was pressed on). A record made in the browser (a city line's
   * forecast or test estimate) resolves from its own registry, for the hover's corner and the card alike.
   */
  function resolve(el: Element): Promise<XrayTarget | null> {
    const h = el as HTMLElement;
    const fhirKey = h.dataset['fhir'];
    const srcKey = h.dataset['src'];
    const weir = h.matches('.rp-weir');
    const key = fhirKey ?? srcKey ?? (weir ? WEIR_REF : '');
    if (fhirKey && isLiveKey(fhirKey)) {
      const live = liveRecord(fhirKey);
      return Promise.resolve(live ? { refs: [live.ref], proposed: false } : null);
    }
    const hit = resolved.get(el);
    if (hit && hit.key === key) return hit.target;
    const target = (async (): Promise<XrayTarget | null> => {
      const idx = await index();
      if (fhirKey) return resolveKey(fhirKey, idx);
      if (weir) return resolveKey(WEIR_REF, idx);
      const s = parseSampleSrc(srcKey ?? '');
      if (!s) return null;
      const replayKey = s.file.slice('replay_'.length, -'.json'.length) as ReplayKey;
      let p = replays.get(replayKey);
      if (!p) replays.set(replayKey, (p = deps.data.replay(replayKey)));
      const sample = (await p).samples[s.index];
      return sample ? resolveSample(sample.time_utc, idx) : null;
    })().catch((e: unknown) => {
      console.error(e);
      return null;
    });
    resolved.set(el, { key, target });
    return target;
  }

  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    if (getComputedStyle(el).visibility !== 'visible') return false;
    let o = 1;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) o *= Number.parseFloat(getComputedStyle(e).opacity);
    return o > 0.3;
  };
  const candidates = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(CANDIDATES)].filter((e) => !e.closest('.xr-layer') && shown(e));
  /** The candidate under a point (a small margin around each), the smallest when they overlap. */
  const candidateAt = (x: number, y: number): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let area = Infinity;
    for (const e of candidates()) {
      const r = e.getBoundingClientRect();
      if (x < r.left - 6 || x > r.right + 6 || y < r.top - 6 || y > r.bottom + 6) continue;
      if (r.width * r.height < area) {
        area = r.width * r.height;
        best = e;
      }
    }
    return best;
  };
  const primary = (): HTMLElement | null => {
    const f = document.activeElement?.closest<HTMLElement>(CANDIDATES);
    if (f && shown(f)) return f;
    let best: HTMLElement | null = null;
    for (const e of candidates()) if (!best || e.getBoundingClientRect().height > best.getBoundingClientRect().height) best = e;
    return best;
  };

  // ----- the card -----

  let card: Card | null = null;
  let opening = false;
  let offFrame: (() => void) | null = null;

  function valueHtml(src: string, value: string | number | boolean): string {
    // a flag has no digits to trace: it is typeset as it is
    if (typeof value === 'boolean') return `<span>${String(value)}</span>`;
    if (typeof value === 'number') return `<span data-src="${esc(src)}" data-fmt="raw">${esc(JSON.stringify(value))}</span>`;
    // a line may break after a slash (never inside a name); <wbr> adds no text, so data-src still matches
    const brk = (t: string): string => esc(t).replace(/\//g, '/<wbr>');
    const cut = /^https?:\/\//.test(value) ? value.lastIndexOf('/') + 1 : 0;
    const inner = cut > 0 ? `<span class="xr-pre">${brk(value.slice(0, cut))}</span>${esc(value.slice(cut))}` : brk(value);
    return `"<span data-src="${esc(src)}">${inner}</span>"`;
  }

  /**
   * The back of a card. `summary` is the validator's mark for the published package; a record made in the browser
   * has none (null). `heading` names what the record is; `published` adds the published forecast peak as a link.
   */
  function buildBack(resources: readonly Shown[], target: XrayTarget, hotColour: string, summary: ValidatorSummary | null, heading: string | null, published: string | null, lead: string | null = null): HTMLElement {
    const back = document.createElement('div');
    back.className = 'xr-back';
    back.tabIndex = -1;
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-label', 'The OneAquaHealth FHIR resource behind this. Escape turns it back.');
    let html = '';
    if (heading) html += `<p class="xr-head">${esc(heading)}</p>`;
    if (target.proposed) {
      const about = resources.some((r) => JSON.stringify(r.json).includes(`"${WEIR_REF}"`));
      html += `<p class="xr-note">proposed extension${about ? ', issued at Warleigh Weir' : ''}</p>`;
    }
    // on a phone a record made on screen leads with what was observed, when, and the estimate; its identifiers and
    // raw fields wait behind "Identifiers"
    if (lead) html += `${lead}<details class="xr-more"><summary>Identifiers</summary>`;
    html += '<div class="xr-code" data-code>';
    for (const { json, src } of resources) {
      html += '<div class="xr-res">';
      for (const l of keyLines(json)) {
        const vals = l.values.map((v) => valueHtml(src(v.ptr), v.value)).join(', ');
        html += `<div class="xr-l${l.hot ? ' xr-hot' : ''}"><span class="xr-k">${esc(l.key)}</span><span class="xr-v"${l.hot ? ` style="color:${esc(hotColour)}"` : ''}>${vals}</span></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    if (lead) html += '</details>';
    if (published) html += `<button type="button" class="xr-link" data-ref="${esc(published)}">Published forecast peak</button>`;
    if (!summary) {
      back.innerHTML = html;
      return back;
    }
    const errors = summary.counts.error;
    const fatal = summary.counts.fatal;
    if (!Number.isInteger(errors) || !Number.isInteger(fatal)) throw new Error('x-ray: the validator summary has no error and fatal counts');
    const clean = errors === 0 && fatal === 0;
    const glyph = clean ? '<path d="M3.2 8.6l3 3 6.6-7.2" />' : '<path d="M4 4l8 8M12 4l-8 8" />';
    const fatalHtml = fatal > 0 ? ` and <span class="xr-n" data-src="fhir/sayr.summary.json#/counts/fatal">${fatal}</span> fatal` : '';
    html +=
      `<p class="xr-mark${clean ? '' : ' xr-bad'}"><svg viewBox="0 0 16 16" aria-hidden="true">${glyph}</svg>` +
      `<span class="xr-mt"><span class="xr-n" data-src="fhir/sayr.summary.json#/counts/error">${errors}</span> error${errors === 1 ? '' : 's'}${fatalHtml} &middot; <i data-unit>HL7</i> validator &middot; OneAquaHealth guide</span></p>`;
    back.innerHTML = html;
    return back;
  }

  /** The phone card's lead for a record made on screen: the test reading (if any), the estimate with its unit, the hour. */
  function leadOf(live: NonNullable<ReturnType<typeof liveRecord>>): string {
    const j = live.json as { valueQuantity?: { value?: number }; component?: { valueBoolean?: boolean }[] };
    const v = j.valueQuantity?.value;
    const flag = j.component?.find((c) => typeof c.valueBoolean === 'boolean')?.valueBoolean;
    let h = '';
    if (typeof flag === 'boolean') h += `<p class="xr-lead">Test reading: ${flag ? 'over <span data-num="thresholds.ecoli_flag_per_100ml">900</span>' : '<span data-num="thresholds.ecoli_flag_per_100ml">900</span> or less'}</p>`;
    if (typeof v === 'number')
      h += `<p class="xr-lead xr-est"><span data-src="${esc(live.src('/valueQuantity/value'))}" data-fmt="pct:1">${formatNumber(v, 'pct:1')}</span> chance over <span data-num="thresholds.ecoli_flag_per_100ml">900</span> <span data-unit>E. coli/100 ml</span></p>`;
    if (live.when) h += `<p class="xr-lead"><span data-time>${esc(live.when)}</span></p>`;
    return h;
  }

  function ghostOf(el: HTMLElement, r: DOMRect): HTMLElement {
    const g = el.cloneNode(true) as HTMLElement;
    for (const e of [g, ...g.querySelectorAll<HTMLElement>('*')]) {
      e.removeAttribute('id');
      e.removeAttribute('data-fhir');
    }
    const cs = getComputedStyle(el);
    const scale = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
    g.className = 'xr-ghost';
    g.removeAttribute('style');
    g.setAttribute('aria-hidden', 'true');
    Object.assign(g.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      font: cs.font,
      fontSize: `${Number.parseFloat(cs.fontSize) * scale}px`,
      lineHeight: `${Number.parseFloat(cs.lineHeight) * scale || r.height}px`,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textShadow: cs.textShadow,
      textAlign: cs.textAlign,
      whiteSpace: cs.whiteSpace,
      textWrap: cs.getPropertyValue('text-wrap') || 'wrap',
    });
    return g;
  }

  function place(back: HTMLElement, r: DOMRect): void {
    const W = innerWidth;
    const H = innerHeight;
    const phone = W < 700;
    const m = phone ? 16 : 28;
    back.style.maxWidth = `${Math.min(860, W - 2 * m)}px`;
    const w = back.offsetWidth;
    const h = back.offsetHeight;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top0 = phone ? 64 : 76;
    const left = clamp(cx - w / 2, m, W - m - w);
    const top = clamp(cy - h / 2, top0, Math.max(top0, H - 64 - h));
    back.style.left = `${Math.round(left)}px`;
    back.style.top = `${Math.round(top)}px`;
    back.style.transformOrigin = `${Math.round(clamp(cx - left, 0, w))}px 50%`;
  }

  function render(c: Card): void {
    const p = c.p;
    deps.scene.style.opacity = (1 - 0.92 * smooth(p / 0.62)).toFixed(3);
    if (c.ghost) {
      const a = p < HALF ? easeIn(p / HALF) * 90 : 90;
      c.ghost.style.transform = `perspective(900px) rotateY(${a.toFixed(2)}deg)`;
      c.ghost.style.visibility = p < HALF ? 'visible' : 'hidden';
    }
    const q = clamp((p - HALF) / (1 - HALF), 0, 1);
    c.back.style.transform = `perspective(1300px) rotateY(${(-90 * (1 - easeOut(q))).toFixed(2)}deg)`;
    c.back.style.visibility = p > HALF ? 'visible' : 'hidden';
    if (p >= 1) c.back.dataset['open'] = 'true';
    else delete c.back.dataset['open'];
    const n = c.lines.length;
    c.lines.forEach((l, i) => {
      l.style.opacity = smooth((q - 0.25 - (0.35 * i) / Math.max(1, n)) / 0.4).toFixed(3);
    });
  }

  function frame(): void {
    const c = card;
    if (!c) return;
    const now = deps.clock.seconds();
    const dt = clamp(now - c.last, 0, 0.1);
    c.last = now;
    c.p = deps.reducedMotion ? (c.dir > 0 ? 1 : 0) : clamp(c.p + (c.dir * dt) / TURN, 0, 1);
    render(c);
    if (c.dir < 0 && c.p <= 0) finishClose();
  }

  function finishClose(): void {
    const c = card;
    if (!c) return;
    card = null;
    offFrame?.();
    offFrame = null;
    c.back.remove();
    c.ghost?.remove();
    c.el.classList.remove('xr-src');
    deps.scene.style.opacity = '';
    document.body.classList.remove('xr-open');
    deps.pause?.(false);
    if (c.focusBack instanceof HTMLElement && document.contains(c.focusBack)) c.focusBack.focus({ preventScroll: true });
  }

  function close(now = false): void {
    const c = card;
    if (!c) return;
    if (now) {
      finishClose();
      return;
    }
    c.dir = -1;
    c.last = deps.clock.seconds();
    if (deps.reducedMotion) finishClose();
  }

  const served = async (refs: readonly string[]): Promise<Shown[]> =>
    Promise.all(refs.map(async (ref) => ({ ref, json: await fetchJson<Json>(`${deps.base}fhir/${ref}.json`), src: (ptr: string) => `fhir/${ref}.json#${ptr}` })));

  async function open(el?: HTMLElement | null, opts: { story?: boolean; refs?: readonly string[] } = {}): Promise<boolean> {
    if (card || opening) return false;
    const target0 = el ?? primary();
    if (!target0) return false;
    opening = true;
    try {
      // the stream's line at a place and hour: the record made from the state on screen (no validator's mark)
      const key = target0.dataset['fhir'] ?? '';
      const live = !opts.refs && isLiveKey(key) ? liveRecord(key) : null;
      const target = opts.refs ? { refs: opts.refs, proposed: false } : await resolve(target0);
      if (!target || card) return false;
      const [resources, summary] = live
        ? [[{ ref: live.ref, json: live.json, src: live.src }], null]
        : await Promise.all([served(target.refs), fetchJson<ValidatorSummary>(`${deps.base}fhir/sayr.summary.json`)]);
      if (!document.contains(target0) || !shown(target0)) return false;
      const r = target0.getBoundingClientRect();
      const over = target0.classList.contains('rp-over');
      const heading = live ? live.heading : opts.refs ? 'Published forecast peak' : null;
      const back = buildBack(resources, target, over ? 'var(--t-high)' : 'var(--ink)', summary, heading, live?.published ?? null, live && innerWidth < 700 ? leadOf(live) : null);
      back.querySelector<HTMLButtonElement>('.xr-link')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const ref = (e.currentTarget as HTMLElement).dataset['ref']!;
        const from = c.el;
        close(true);
        void open(from, { story: c.story, refs: [ref] });
      });
      back.style.visibility = 'hidden';
      layer.append(back);
      place(back, r);
      const ghost = deps.reducedMotion ? null : ghostOf(target0, r);
      if (ghost) layer.append(ghost);
      target0.classList.add('xr-src');
      document.body.classList.add('xr-open');
      deps.pause?.(true);
      ear.hidden = true;
      const c: Card = {
        story: opts.story === true,
        el: target0,
        back,
        ghost,
        lines: [...back.querySelectorAll<HTMLElement>('.xr-head, .xr-note, .xr-lead, .xr-more, .xr-l, .xr-link, .xr-mark')],
        p: 0,
        dir: 1,
        last: deps.clock.seconds(),
        focusBack: document.activeElement,
      };
      card = c;
      render(c);
      offFrame = deps.clock.onFrame(frame);
      if (deps.reducedMotion) frame();
      back.focus({ preventScroll: true });
      return true;
    } catch (e) {
      console.error('x-ray: could not open the resource', e);
      return false;
    } finally {
      opening = false;
    }
  }

  // ----- gestures -----

  let press: { x: number; y: number; el: HTMLElement; timer: number } | null = null;
  let swallowClick = false;
  const cancelPress = (): void => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      if (card) {
        if (card.back.contains(e.target as Node)) return;
        swallow(e);
        swallowClick = true;
        close();
        return;
      }
      if (e.target === ear || ear.contains(e.target as Node)) return;
      const el = candidateAt(e.clientX, e.clientY);
      if (!el) return;
      // a press on something that turns over belongs to the x-ray (the scene under it does not close or fold)
      e.stopPropagation();
      if (e.altKey) {
        e.preventDefault();
        swallowClick = true;
        void open(el);
        return;
      }
      cancelPress();
      void resolve(el); // warm the lookup while the finger rests
      press = {
        x: e.clientX,
        y: e.clientY,
        el,
        timer: window.setTimeout(() => {
          const p = press;
          press = null;
          if (!p) return;
          swallowClick = true;
          void open(p.el);
        }, LONG_PRESS_MS),
      };
    },
    { capture: true },
  );
  document.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 9) cancelPress();
    // the folded corner follows a hovering mouse, never a drag (a scrub of the strip runs every frame)
    if (e.pointerType !== 'touch' && e.buttons === 0) hoverAt(e.clientX, e.clientY, e.target);
  });
  for (const t of ['pointerup', 'pointercancel'] as const) document.addEventListener(t, cancelPress, { capture: true });
  document.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      swallow(e);
    },
    { capture: true },
  );
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (press || candidateAt(e.clientX, e.clientY)) e.preventDefault();
    },
    { capture: true },
  );
  window.addEventListener(
    'keydown',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape' && card) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (card) close();
        else void open();
      }
    },
    { capture: true },
  );
  addEventListener('hashchange', () => close(true));

  // ----- the folded corner on hover -----

  let hover: HTMLElement | null = null;
  let hoverToken = 0;
  let earOff: (() => void) | null = null;
  const placeEar = (): void => {
    if (!hover || card || !shown(hover)) {
      ear.hidden = true;
      return;
    }
    const r = hover.getBoundingClientRect();
    // the button's 44 px square is centred on the element's top right corner, where the fold is drawn
    ear.style.left = `${Math.round(clamp(r.right - 22, 0, innerWidth - 44))}px`;
    ear.style.top = `${Math.round(clamp(r.top - 22, 0, innerHeight - 44))}px`;
  };
  function hoverAt(x: number, y: number, t: EventTarget | null): void {
    if (card) return;
    if (t === ear || ear.contains(t as Node)) return;
    const el = candidateAt(x, y);
    if (el === hover) return;
    hover = el;
    const token = ++hoverToken;
    if (!el) {
      ear.hidden = true;
      earOff?.();
      earOff = null;
      return;
    }
    void resolve(el).then((target) => {
      if (token !== hoverToken || !target || card) return;
      ear.hidden = false;
      placeEar();
      earOff ??= deps.clock.onFrame(placeEar);
    });
  }
  ear.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = hover;
    ear.hidden = true;
    if (el) void open(el);
  });

  return { isOpen: () => card !== null || opening, holds: () => (card !== null && !card.story) || opening, close: () => close(), open };
}
