// The one app clock (see SceneClock in src/scenes/types.ts). Two timelines:
//   data time  the instant the screen shows (which forecast hour, which "now"); ms() and now()
//   anim time  seconds that drive motion (flow, fog drift, tweens); seconds()
// Modes:
//   live     data time = the real time; anim time runs in real time
//   ?t=X     data time pinned at X; anim time runs in real time (the scene moves, the hour does not)
//   ?t=X&rate=r  data time runs from X at r times real speed; anim time in real time
//   manual   nothing advances on its own; window.__sayrClock.step(ms) advances anim time by ms and data time by
//            ms * rate; .set(date) sets data time. The first set/step call (or ?clock=manual) enters manual mode,
//            so a film can be rendered frame by frame.
// This module is the only place in the app that reads real time.
import type { SceneClock } from '../scenes/types';

export interface ClockOptions {
  /** Data time at start (epoch ms); null means live. */
  readonly startMs: number | null;
  /** Data seconds per real second once running; 0 pins the data time. */
  readonly rate: number;
  readonly manual: boolean;
}

export interface ClockControl {
  set(date: Date | string | number): void;
  step(ms: number): void;
  readonly mode: 'live' | 'pinned' | 'running' | 'manual';
}

export interface AppClock extends SceneClock {
  /** Advances the clock to the real time `realMs` and calls every frame listener. Called by the frame loop. */
  frame(realMs: number): void;
  readonly control: ClockControl;
  /** Called when data time is changed by set() (listeners that cache the hour should refresh). */
  onJump(fn: () => void): () => void;
}

/** A date-time without a zone ("2026-09-28T06:00") is read as UTC, never in the viewer's own zone. */
export function parseInstant(t: string): number {
  const zoned = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(t) || !t.includes('T');
  return Date.parse(zoned ? t : `${t}Z`);
}

/** Reads ?t=<ISO>, ?rate=<x> and ?clock=manual. Throws on a malformed value so a bad film URL fails loudly. */
export function clockOptionsFromQuery(search: string): ClockOptions {
  const q = new URLSearchParams(search);
  const t = q.get('t');
  const rateRaw = q.get('rate');
  let startMs: number | null = null;
  if (t !== null && t !== 'live') {
    startMs = parseInstant(t);
    if (!Number.isFinite(startMs)) throw new Error(`?t=${t} is not an ISO date-time`);
  }
  let rate = startMs === null ? 1 : 0;
  if (rateRaw !== null) {
    rate = Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`?rate=${rateRaw} must be a number of 0 or more`);
  }
  return { startMs, rate, manual: q.get('clock') === 'manual' };
}

/**
 * The app's reading of the query: a malformed ?t or ?rate is dropped (with the reason) and the clock runs live,
 * so a mistyped link still opens the app.
 */
export function clockOptionsLenient(search: string): { opts: ClockOptions; problems: string[] } {
  try {
    return { opts: clockOptionsFromQuery(search), problems: [] };
  } catch (e) {
    const q = new URLSearchParams(search);
    const problems = [(e as Error).message];
    let opts: ClockOptions = { startMs: null, rate: 1, manual: q.get('clock') === 'manual' };
    // keep a good ?t when only the rate is bad
    const t = q.get('t');
    if (t !== null && t !== 'live' && Number.isFinite(parseInstant(t))) opts = { ...opts, startMs: parseInstant(t), rate: 0 };
    return { opts, problems };
  }
}

/**
 * `realNow` returns real epoch ms (Date.now in the app, a fake in tests); `onError` hears a frame listener that
 * threw (console.error in the app).
 */
export function createClock(opts: ClockOptions, realNow: () => number, onError: (e: unknown) => void = (e) => console.error(e)): AppClock {
  const r0 = realNow();
  let dataMs = opts.startMs ?? r0;
  let rate = opts.startMs === null ? 1 : opts.rate;
  let manual = opts.manual;
  let anim = 0;
  let lastReal = r0;
  const frameFns = new Set<(t: Date) => void>();
  const jumpFns = new Set<() => void>();
  const mode = (): ClockControl['mode'] => (manual ? 'manual' : opts.startMs === null ? 'live' : rate === 0 ? 'pinned' : 'running');

  // Each listener runs on its own: one that throws is reported once and never stops the others or the next frame.
  const reported = new WeakMap<(t: Date) => void, Set<string>>();
  const notify = (): void => {
    const d = new Date(dataMs);
    for (const fn of [...frameFns]) {
      try {
        fn(d);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        let seen = reported.get(fn);
        if (!seen) reported.set(fn, (seen = new Set()));
        if (!seen.has(msg)) {
          seen.add(msg);
          onError(e);
        }
      }
    }
  };

  const control: ClockControl = {
    set(date) {
      const ms = typeof date === 'number' ? date : typeof date === 'string' ? Date.parse(date) : date.getTime();
      if (!Number.isFinite(ms)) throw new Error(`__sayrClock.set: not a date: ${String(date)}`);
      manual = true;
      dataMs = ms;
      for (const fn of [...jumpFns]) fn();
      notify();
    },
    step(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`__sayrClock.step: ms must be 0 or more, got ${ms}`);
      manual = true;
      anim += ms / 1000;
      dataMs += ms * (rate === 0 && opts.startMs === null ? 1 : rate);
      notify();
    },
    get mode() {
      return mode();
    },
  };

  return {
    now: () => new Date(dataMs),
    ms: () => dataMs,
    seconds: () => anim,
    get pinned() {
      return manual || rate === 0;
    },
    onFrame(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    onJump(fn) {
      jumpFns.add(fn);
      return () => jumpFns.delete(fn);
    },
    frame(realMs) {
      const dt = Math.max(0, Math.min(realMs - lastReal, 250));
      lastReal = realMs;
      if (!manual) {
        anim += dt / 1000;
        if (opts.startMs === null) dataMs = realMs;
        else dataMs += dt * rate;
      }
      notify();
    },
    control,
  };
}
