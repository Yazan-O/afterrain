// The storm as a schedule: which overflow departs when (Bath time for display), which lab sample arrives
// when, and the tempo that turns the replay window into about 45 seconds of story time.
//
// Two clocks meet here. Storm time is the real instant (UTC ms) the screen shows. Story time (sigma, in
// seconds) is where that instant sits in the scene's pacing: the calm days pass fast, departures and sample
// arrivals slow the story, and the largest sample gets a beat of silence before it and a hold after it.
// The tempo is a pure, monotonic function of storm time, so any storm instant (a pinned ?t=) maps to one
// story moment and renders the same frame every time.
import type { ReplayFile } from '../../data/schemas';
import type { ReplayTimeline } from '../../engine/replay';
import { formatClock, formatDayTime, PLACE_ZONES } from '../../engine/timefmt';

export const BATH_ZONE = PLACE_ZONES.AVON;
/** The overflow whose spill the proof is about (SPEC section 5 A). */
export const HERO_OVERFLOW = 'FRESHFORD STORM TANK';

const HOUR = 3_600_000;
const MIN = 60_000;

export interface Departure {
  readonly overflow: string;
  readonly name: string;
  readonly startMs: number;
  readonly stopMs: number;
  /** Bath wall-clock time of the logged start, "10:28". */
  readonly label: string;
  /** The first spill of this overflow inside the replay window. */
  readonly first: boolean;
  /** The Freshford storm tank's longest spill in the window. */
  readonly hero: boolean;
}

export interface SampleArrival {
  readonly tMs: number;
  readonly value: number;
  readonly over900: boolean;
  /** Bath wall-clock time of the sample, "09:10". */
  readonly label: string;
  /** `<file>#<json pointer>` of the value shown. */
  readonly src: string;
  readonly hero: boolean;
}

export interface Tempo {
  readonly startMs: number;
  readonly endMs: number;
  /** Story seconds from the window start to the window end. */
  readonly duration: number;
  /** Story seconds at a storm instant (clamped to the window). */
  sigmaAt(tMs: number): number;
  /** Storm instant at a story second (clamped). */
  timeAt(sigma: number): number;
}

export interface Schedule {
  readonly key: string;
  readonly file: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly departures: readonly Departure[];
  readonly clicks: readonly { readonly tMs: number; readonly kind: 'on' | 'off'; readonly overflow: string }[];
  readonly samples: readonly SampleArrival[];
  readonly heroDeparture: Departure | null;
  readonly heroSample: SampleArrival | null;
  /** From this storm instant on, the proof is shown. */
  readonly proofMs: number;
  readonly tempo: Tempo;
}

/** A departure whose Bath-time label is formatted when read (one class, so every departure shares its shape). */
class Dep implements Departure {
  constructor(
    readonly overflow: string,
    readonly name: string,
    readonly startMs: number,
    readonly stopMs: number,
    readonly first: boolean,
    readonly hero: boolean,
  ) {}
  get label(): string {
    return formatClock(this.startMs, BATH_ZONE);
  }
}

const gauss = (x: number, w: number): number => Math.exp(-0.5 * (x / w) ** 2);
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** A smooth bump on [a, b] whose integral over storm hours is `area`. */
const window01 = (a: number, b: number, x: number): number => sstep(a, a + (b - a) * 0.25, x) * (1 - sstep(b - (b - a) * 0.25, b, x));

/** Schedules already built, per storm (story mode builds the 2024 one before it mounts the scene). */
const built = new Map<string, { print: string; schedule: Schedule }>();

/** What identifies one replay file's contents: its storm, window and the sizes of its logs. */
const fingerprint = (key: string, pack: ReplayFile): string =>
  [key, pack.window_utc.join('/'), pack.overflows.length, pack.overflows.reduce((n, o) => n + o.events.length, 0), pack.samples.length, pack.flow_daily.length, pack.rain_daily.length].join('|');

/**
 * The storm's schedule. A pure function of the replay file, and a replay file does not change while the page is
 * open, so a schedule built from the same storm's file (story mode loads its own copy first) is reused: the
 * scene's mount skips work the story has already done.
 */
export function buildSchedule(key: string, pack: ReplayFile, tl: ReplayTimeline): Schedule {
  const print = fingerprint(key, pack);
  const hit = built.get(key);
  if (hit && hit.print === print) return hit.schedule;
  const schedule = computeSchedule(key, pack, tl);
  built.set(key, { print, schedule });
  return schedule;
}

function computeSchedule(key: string, pack: ReplayFile, tl: ReplayTimeline): Schedule {
  const file = `replay_${key}.json`;
  const { windowStartMs, windowEndMs } = tl;
  const inWindow = (t: number): boolean => t >= windowStartMs && t < windowEndMs;

  const heroTrack = tl.overflows.find((o) => o.key === HERO_OVERFLOW) ?? null;
  const heroIv =
    heroTrack?.intervals
      .filter((iv) => iv.stopMs > windowStartMs && iv.startMs < windowEndMs)
      .reduce<{ startMs: number; stopMs: number } | null>((best, iv) => (!best || iv.stopMs - iv.startMs > best.stopMs - best.startMs ? iv : best), null) ?? null;

  const departures: Departure[] = [];
  for (const o of tl.overflows) {
    let first = true;
    for (const iv of o.intervals) {
      if (!inWindow(iv.startMs)) continue;
      const hero = o.key === HERO_OVERFLOW && heroIv !== null && iv.startMs === heroIv.startMs;
      // the label is formatted when it is read: the 2024 storm has 981 departures and only 25 carry a label
      departures.push(new Dep(o.key, o.name, iv.startMs, iv.stopMs, first, hero));
      first = false;
    }
  }
  // ordinal order of the keys (upper-case ASCII names): the same order as a collator, without its cost
  departures.sort((a, b) => a.startMs - b.startMs || (a.overflow < b.overflow ? -1 : a.overflow > b.overflow ? 1 : 0));

  const clicks = tl.events.filter((e) => inWindow(e.tMs));

  // The value shown is pointed at by its index in the file (the timeline sorts; the file may not).
  const fileIndex = (tMs: number): number => pack.samples.findIndex((s) => Date.parse(s.time_utc) === tMs);
  const inWin = tl.samples.filter((s) => inWindow(s.tMs));
  const maxValue = Math.max(...inWin.map((s) => s.ecoliPer100ml));
  const samples: SampleArrival[] = inWin.map((s) => {
    const i = fileIndex(s.tMs);
    if (i < 0) throw new Error(`sample at ${new Date(s.tMs).toISOString()} is not in ${file}`);
    return {
      tMs: s.tMs,
      value: s.ecoliPer100ml,
      over900: s.over900,
      label: formatClock(s.tMs, BATH_ZONE),
      src: `${file}#/samples/${i}/ecoli_per_100ml`,
      hero: s.ecoliPer100ml === maxValue && inWin.findIndex((x) => x.ecoliPer100ml === maxValue) === inWin.indexOf(s),
    };
  });
  const heroSample = samples.find((s) => s.hero) ?? null;
  const heroDeparture = departures.find((d) => d.hero) ?? null;
  const lastSample = samples.length ? samples[samples.length - 1]!.tMs : windowEndMs - 6 * HOUR;
  const proofMs = Math.min(windowEndMs - HOUR, lastSample + 3 * HOUR);

  const tempo = buildTempo({ windowStartMs, windowEndMs, departures, samples, heroSample, heroDeparture, proofMs });
  return { key, file, windowStartMs, windowEndMs, departures, clicks, samples, heroDeparture, heroSample, proofMs, tempo };
}

interface TempoInput {
  windowStartMs: number;
  windowEndMs: number;
  departures: readonly Departure[];
  samples: readonly SampleArrival[];
  heroSample: SampleArrival | null;
  heroDeparture: Departure | null;
  proofMs: number;
}

/** Story-second budget of each beat. Tuned by eye for the 23 September 2024 storm; the 2023 storm reuses it. */
export const TEMPO = {
  basePerHour: 0.035,
  stormPerHour: 0.085,
  departure: 0.17,
  departureWidthH: 0.7,
  heroDeparture: 1.7,
  sample: 0.65,
  silenceBefore: 2.2,
  silenceMin: 40,
  hold: 3.2,
  landing: 0.9,
  holdMin: 55,
  proof: 5,
  /** a calm opening in which the scene's one line can be read (it leaves before the first sample lands) */
  opening: 2.2,
  openingH: 3,
} as const;

export function buildTempo(x: TempoInput): Tempo {
  const { windowStartMs: t0, windowEndMs: t1 } = x;
  const firsts = x.departures.filter((d) => d.first || d.hero);
  const stormA = firsts.length ? Math.min(...firsts.map((d) => d.startMs)) - 3 * HOUR : t0;
  const stormB = x.heroSample ? x.heroSample.tMs + 8 * HOUR : firsts.length ? Math.max(...firsts.map((d) => d.startMs)) + 8 * HOUR : t0;
  const depW = TEMPO.departureWidthH;
  const depA = TEMPO.departure / (depW * Math.sqrt(2 * Math.PI));
  const heroW = 0.4;
  const heroA = TEMPO.heroDeparture / (heroW * Math.sqrt(2 * Math.PI));
  const sW = 0.25;
  const sA = TEMPO.sample / (sW * Math.sqrt(2 * Math.PI));
  const hs = x.heroSample?.tMs ?? null;
  const silH = TEMPO.silenceMin / 60;
  const holdH = TEMPO.holdMin / 60;
  const proofH = Math.max(0.5, (t1 - x.proofMs) / HOUR);

  // sigma-seconds per storm hour at t
  const density = (t: number): number => {
    let d: number = TEMPO.basePerHour;
    const h = (t - t0) / HOUR;
    d += (TEMPO.opening / (TEMPO.openingH * 0.75)) * window01(-TEMPO.openingH, TEMPO.openingH, h);
    d += TEMPO.stormPerHour * sstep((stormA - t0) / HOUR - 2, (stormA - t0) / HOUR + 2, h) * (1 - sstep((stormB - t0) / HOUR - 2, (stormB - t0) / HOUR + 2, h));
    for (const dep of firsts) {
      const dh = (t - dep.startMs) / HOUR;
      if (Math.abs(dh) < 4 * depW) d += depA * gauss(dh - 0.15, depW);
      if (dep.hero && Math.abs(dh) < 4 * heroW) d += heroA * gauss(dh - 0.12, heroW);
    }
    for (const s of x.samples) {
      if (s.hero) continue;
      const dh = (t - s.tMs) / HOUR;
      if (Math.abs(dh) < 4 * sW) d += sA * gauss(dh, sW);
    }
    if (hs !== null) {
      const dh = (t - hs) / HOUR;
      // one slow envelope from the beat of silence (the 40 minutes before) through the hold (the 55 minutes
      // after), and the clock all but stops for the landing itself
      const plateau = (TEMPO.silenceBefore + TEMPO.hold) / (silH * 0.75 + holdH * 0.8);
      d += plateau * sstep(-silH, -silH * 0.5, dh) * (1 - sstep(holdH * 0.6, holdH, dh));
      if (Math.abs(dh) < 0.3) d += (TEMPO.landing / (0.05 * Math.sqrt(2 * Math.PI))) * gauss(dh - 0.01, 0.05);
    }
    if (t >= x.proofMs) d = Math.max(d, TEMPO.proof / proofH);
    return d;
  };

  const n = Math.max(2, Math.ceil((t1 - t0) / MIN));
  const cum = new Float64Array(n + 1);
  let prev = density(t0);
  for (let i = 1; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const cur = density(t);
    cum[i] = cum[i - 1]! + ((prev + cur) / 2) * ((t1 - t0) / n / HOUR);
    prev = cur;
  }
  const duration = cum[n]!;
  const step = (t1 - t0) / n;

  return {
    startMs: t0,
    endMs: t1,
    duration,
    sigmaAt(tMs) {
      const f = (Math.min(Math.max(tMs, t0), t1) - t0) / step;
      const i = Math.min(n - 1, Math.floor(f));
      return cum[i]! + (cum[i + 1]! - cum[i]!) * (f - i);
    },
    timeAt(sigma) {
      const s = Math.min(Math.max(sigma, 0), duration);
      let lo = 0;
      let hi = n;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid;
        else hi = mid;
      }
      const span = cum[hi]! - cum[lo]!;
      return t0 + step * (lo + (span > 0 ? (s - cum[lo]!) / span : 0));
    },
  };
}

/** The clock line, "Tue 24 Sep 09:10", in Bath time. */
export const clockLabel = (tMs: number): string => formatDayTime(tMs, BATH_ZONE);
