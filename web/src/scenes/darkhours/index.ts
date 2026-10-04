// W2 "The dark hours" (#/dark-hours). OneAquaHealth's 96 samples fall onto a rain axis (the three days before)
// and 80 settle on the dry side; the five cities; then the Garonne's samples at Toulouse fall onto the rain of
// the two days before, white and, as the rain rises, orange (over 900 E. coli per 100 ml); the storm side's fog
// fills the screen and the shell cross-fades it into the city map.
//
// #/dark-hours/<beat> opens at the start of a beat (fall, line, cities, storm, end), and a change of that hash
// while the scene is up (a link, back or forward) moves it there. Coming back after the hand-off lands on the
// Garonne (storm), never the whole scene again. Space or the right arrow skips ahead, the left arrow goes back.
// Every frame is a function of the app clock.
import type { Scene, SceneContext } from '../types';
import { Taps } from './audio';
import { buildCopy, formatDay, type Copy } from './copy';
import { buildDrops, rainFrac, STORM_SIDE_MM, xOf } from './layout';
import { Painter } from './render';
import './style.css';
import {
  BEAT_START,
  BEATS,
  CITY_LABELS,
  CITY_OUT,
  HANDOFF,
  LINE_IN,
  LINE_OUT,
  NAVIGATE_AT,
  NUM_LINES,
  OPEN_AT,
  REGROUP,
  RETURN_BEAT,
  SETTLED,
  beatAt,
  startOf,
  stillFor,
  window01,
  type Beat,
} from './timeline';

const beatOf = (params: readonly string[]): Beat | null => {
  const b = params[0];
  return b !== undefined && (BEATS as readonly string[]).includes(b) ? (b as Beat) : null;
};

const show = (el: HTMLElement, a: number): void => {
  const v = a < 0.02 ? 0 : a;
  el.style.opacity = v.toFixed(3);
  el.style.visibility = v === 0 ? 'hidden' : 'visible';
};

export default function createScene(): Scene {
  let ctx: SceneContext | null = null;
  let host: HTMLElement | null = null;
  let painter: Painter | null = null;
  let copy: Copy | null = null;
  let taps: Taps | null = null;
  const offs: (() => void)[] = [];
  /** Scene time = clock seconds - s0 + offset. */
  let s0 = 0;
  let offset = 0;
  let mountMs = 0;
  let lastT = -1;
  let navigated = false;
  /** Scene second the scene starts from once its data is in: 0, a deep link's beat, or a route change's. */
  let startAt = 0;
  let hover = -1;
  let alive = false;

  const sceneT = (): number => (ctx ? Math.max(0, ctx.clock.seconds() - s0 + offset) : 0);

  const jump = (to: number): void => {
    if (!ctx) return;
    offset += to - sceneT();
    // moving back before the hand-off (a key, a link, back or forward) lets the scene hand off again later
    if (to < NAVIGATE_AT) navigated = false;
    lastT = -1;
  };

  const layoutText = (): void => {
    if (!painter || !copy || !host) return;
    const g = painter.g;
    const put = (el: HTMLElement, x: number, y: number): void => {
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    };
    host.style.setProperty('--dh-text-w', `${Math.min(g.x1 - g.x0, g.phone ? 9999 : 900)}px`);
    for (const el of [copy.line.parentElement!, ...copy.nums]) put(el, g.textX, g.textY);
    put(copy.markDry, xOf(g, copy.dryMm), g.gy1 + 12);
    put(copy.markWet, xOf(g, copy.wetMm), g.gy1 + 12);
    // what each side means, on the marks' line: the dry (or less rainy) side left of the edge, the storm side
    // under the fog at the wet end
    put(copy.sideDry, (g.x0 + xOf(g, copy.dryMm)) / 2, g.gy1 + 12);
    put(copy.sideLess, (g.x0 + xOf(g, copy.wetMm)) / 2, g.gy1 + 12);
    for (const el of [copy.sideStorm, copy.sideStorm2]) put(el, xOf(g, STORM_SIDE_MM), g.gy1 + 12);
    // what the axis counts, in words, under its storm end
    for (const el of [copy.axis3, copy.axis2]) put(el, g.x1, g.gy1 + (g.phone ? 36 : 42));
    put(copy.river, g.x0, g.gy1 + (g.phone ? 34 : 38));
    painter.cityRows().forEach((r, k) => put(copy!.cities[k]!, g.x0, r.y + 9));
  };

  const resize = (): void => {
    if (!host || !painter) return;
    const r = host.getBoundingClientRect();
    painter.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)), Math.min(2, window.devicePixelRatio || 1));
    layoutText();
    lastT = -1;
    frame();
  };

  /** The colour's word appears beside the first orange drop as it lands, then fades. */
  const placeFlagWord = (T: number): void => {
    if (!painter || !copy) return;
    const i = painter.firstFlag;
    const land = painter.firstFlagLand;
    show(copy.flag, window01(T, land + 0.2, land + 4.2, 0.6));
    if (i < 0 || T < land) return;
    const f = painter.frame;
    const x = f.px[i]!;
    let top = f.py[i]!;
    for (let k = 0; k < f.px.length; k++) if (f.pa[k]! > 0.1 && Math.abs(f.px[k]! - x) < 90 && f.py[k]! < top) top = f.py[k]!;
    const w = copy.flag.offsetWidth;
    copy.flag.style.left = `${Math.round(Math.min(Math.max(16, x - w / 2), painter.g.W - 16 - w))}px`;
    copy.flag.style.top = `${Math.round(top - copy.flag.offsetHeight - 18)}px`;
  };

  const frame = (): void => {
    if (!ctx || !painter || !copy || !host || !alive) return;
    const T = sceneT();
    const Td = ctx.reducedMotion ? stillFor(T) : T;
    painter.draw(Td);

    // Words: each fades in and out with its beat.
    show(copy.line, window01(Td, LINE_IN, LINE_OUT));
    // The 3-day axis (1 mm, the dry edge) under OneAquaHealth; the 2-day axis (5 mm) under the Garonne. What the
    // 3-day axis counts stays while the sentence names OneAquaHealth's samples (the sentence's "dry
    // days" are that axis); its two sides' words teach while the drops fall and step aside for the sentence.
    const oahAxis = window01(Td, 0.8, LINE_OUT, 1);
    const garAxis = window01(Td, REGROUP + 1.2, HANDOFF, 0.8);
    show(copy.markDry, oahAxis);
    const oahWords = window01(Td, 0.8, LINE_IN - 0.15, 0.25);
    show(copy.axis3, oahAxis);
    show(copy.sideDry, oahWords);
    show(copy.sideStorm, oahWords);
    show(copy.markWet, garAxis);
    show(copy.axis2, garAxis);
    // the Garonne's sides teach while its drops fall, and step aside for the lines of numbers (the word budget)
    const garWords = window01(Td, REGROUP + 1.2, NUM_LINES[0]![0] - 0.7, 0.6);
    show(copy.sideLess, garWords);
    show(copy.sideStorm2, garWords);
    copy.cities.forEach((el, k) => show(el, window01(Td, CITY_LABELS + 0.14 * k, CITY_OUT)));
    show(copy.river, window01(Td, OPEN_AT - 0.4, HANDOFF, 0.8));
    copy.nums.forEach((el, k) => show(el, window01(Td, NUM_LINES[k]![0], NUM_LINES[k]![1], 0.5)));
    placeFlagWord(Td);
    drawTip();
    // the scene's own sources beside the shell's credits, whenever the viewer opens them
    const shellCredits = document.querySelector<HTMLElement>('.credits');
    const open = shellCredits !== null && !shellCredits.hidden;
    copy.credits.hidden = !open;
    if (open) copy.credits.style.bottom = `${Math.round(painter.g.H - shellCredits.getBoundingClientRect().top + 6)}px`;

    const beat = beatAt(T);
    if (host.dataset['beat'] !== beat) host.dataset['beat'] = beat;
    host.dataset['t'] = T.toFixed(2);

    // Sound: the drops that landed since the last frame (only while playing forward in real time).
    if (taps && !ctx.reducedMotion && lastT >= 0 && T > lastT && T - lastT < 0.25) {
      const landed: number[] = [];
      for (const d of painter.set.all) {
        const l = painter.landAt(d.i);
        if (l > lastT && l <= T) landed.push(d.i);
      }
      for (const i of landed) {
        const d = painter.set.all[i]!;
        taps.tap(rainFrac(d.rain), d.flag, landed.length - 1);
      }
    }
    lastT = T;

    if (!navigated && T >= NAVIGATE_AT) {
      navigated = true;
      // Back from the city should land on the Garonne, not replay the whole scene: this history entry
      // becomes #/dark-hours/storm before the city's is pushed. (Story mode never gets here.)
      if (!ctx.story) {
        const back = `#/dark-hours/${RETURN_BEAT}`;
        if (location.hash !== back) history.replaceState(history.state, '', `${location.pathname}${location.search}${back}`);
      }
      ctx.navigate(`#/city/${ctx.city}`);
    }
  };

  const drawTip = (): void => {
    if (!copy || !painter) return;
    const f = painter.frame;
    if (hover < 0 || f.pa[hover]! < 0.3) {
      show(copy.tip, 0);
      return;
    }
    const d = painter.set.all[hover]!;
    if (copy.tipName.textContent !== d.siteName) copy.tipName.textContent = d.siteName;
    const day = formatDay(d.date);
    if (copy.tipDate.textContent !== day) {
      copy.tipDate.textContent = day;
      copy.tipDate.setAttribute('datetime', d.date);
    }
    const x = f.px[hover]!;
    // Above the top of the heap under the pointer, so the words never cover a drop.
    let top = f.py[hover]!;
    for (let i = 0; i < f.px.length; i++) if (f.pa[i]! > 0.3 && Math.abs(f.px[i]! - x) < 60 && f.py[i]! < top && f.py[i]! > top - 160) top = f.py[i]!;
    const w = copy.tip.offsetWidth;
    copy.tip.style.left = `${Math.round(Math.min(Math.max(16, x - w / 2), painter.g.W - 16 - w))}px`;
    copy.tip.style.top = `${Math.round(top - 34)}px`;
    show(copy.tip, 1);
  };

  const onMove = (e: PointerEvent): void => {
    if (!painter || !host) return;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const f = painter.frame;
    let best = -1;
    let bd = (painter.g.phone ? 16 : 10) ** 2;
    for (let i = 0; i < f.px.length; i++) {
      if (f.pa[i]! < 0.3) continue;
      const dd = (f.px[i]! - x) ** 2 + (f.py[i]! - y) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    hover = best;
  };

  const onKey = (e: KeyboardEvent): void => {
    // a focused control (a button, a link, a field) keeps its own keys: space presses it
    const t = e.target;
    if (t instanceof HTMLElement && t.closest('button, a, input, textarea, select, [role="slider"]')) return;
    const T = sceneT();
    const k = BEATS.indexOf(beatAt(T));
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      const next = BEATS[Math.min(BEATS.length - 1, k + 1)]!;
      jump(next === 'end' ? BEAT_START.end : SETTLED[next] - 1.2);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      const cur = BEATS[k]!;
      const prev = T - BEAT_START[cur] > 1.5 ? cur : BEATS[Math.max(0, k - 1)]!;
      jump(BEAT_START[prev]);
      e.preventDefault();
    }
  };

  return {
    mount(root, context) {
      ctx = context;
      alive = true;
      host = document.createElement('div');
      host.className = 'dh';
      host.dataset['theme'] = context.theme.get();
      const canvas = document.createElement('canvas');
      canvas.className = 'dh-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      host.append(canvas);
      root.append(host);
      mountMs = context.clock.ms();
      const deep = beatOf(context.params);
      startAt = deep ? startOf(deep) : 0;

      Promise.all([context.data.darkHours(), context.data.numbers()])
        .then(([file, numbers]) => {
          if (!alive || !host) return;
          const set = buildDrops(file);
          if (set.missingRain > 0) console.warn(`dark hours: ${set.missingRain} rows have no rain and are not drawn`);
          painter = new Painter(canvas, set, context.theme.get());
          copy = buildCopy(numbers);
          const say = document.createElement('div');
          say.className = 'dh-sayblock';
          say.append(copy.line);
          copy.credits.hidden = true;
          host.append(say, copy.markDry, copy.markWet, copy.axis3, copy.axis2, copy.sideDry, copy.sideStorm, copy.sideLess, copy.sideStorm2, ...copy.cities, copy.river, copy.flag, ...copy.nums, copy.tip, copy.credits);
          for (const el of host.querySelectorAll<HTMLElement>('p:not(.dh-credits), .dh-mark, .dh-axis, .dh-side')) show(el, 0);

          offset = startAt;
          s0 = context.clock.seconds();

          const ro = new ResizeObserver(() => resize());
          ro.observe(host);
          offs.push(() => ro.disconnect());
          offs.push(context.clock.onFrame(() => frame()));
          offs.push(context.theme.subscribe((t) => {
            if (!host || !painter) return;
            host.dataset['theme'] = t;
            painter.setTheme(t);
            frame();
          }));
          taps = new Taps();
          host.addEventListener('pointermove', onMove);
          host.addEventListener('pointerdown', onMove);
          host.addEventListener('pointerleave', () => (hover = -1));
          window.addEventListener('keydown', onKey);
          offs.push(() => window.removeEventListener('keydown', onKey));
          resize();
          host.dataset['ready'] = 'true';
          document.body.dataset['ready'] = 'true';
        })
        .catch((e: unknown) => {
          if (host) host.dataset['ready'] = 'failed';
          document.body.dataset['ready'] = 'failed';
          console.error('dark hours: could not load its data', e);
        });
    },

    unmount() {
      alive = false;
      for (const off of offs.splice(0)) off();
      taps?.dispose();
      taps = null;
      host?.remove();
      host = null;
      painter = null;
      copy = null;
      ctx = null;
    },

    setTime(t) {
      if (!ctx) return;
      jump(Math.max(0, (t.getTime() - mountMs) / 1000));
      frame();
    },

    /**
     * Story mode plays a beat by name ('garonne' is the 'storm' beat, the Garonne at Toulouse): the scene jumps to
     * its start and resolves once it is drawn there. Resolves false for a name it does not know.
     */
    cue(name: string): Promise<boolean> {
      const beat = beatOf([name === 'garonne' ? 'storm' : name]);
      if (!ctx || !beat) return Promise.resolve(false);
      if (!painter) {
        startAt = startOf(beat); // still loading: start there once the data is in
        return Promise.resolve(true);
      }
      jump(startOf(beat));
      frame();
      return Promise.resolve(true);
    },

    /** The hash changed while the scene is up (#/dark-hours/<beat>, back or forward): go to that beat's start. */
    route(params: readonly string[]) {
      if (!ctx || ctx.story) return;
      const beat = beatOf(params);
      const to = beat ? startOf(beat) : 0;
      if (!painter) {
        startAt = to; // still loading: start there once the data is in
        return;
      }
      jump(to);
      frame();
    },
  };
}

