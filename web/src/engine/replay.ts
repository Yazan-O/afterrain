// A storm replay as a timeline: overflow on/off events (UTC), the samples, and daily flow and rain.
// Spill records that touch or overlap (the log often splits one spill into one-minute rows) are merged
// into one interval; a gap of any length, even one minute, keeps two spills separate, as the log records it.
import type { FlowDay, RainDay, ReplayFile } from '../data/schemas';
import { parseUtc } from './timefmt';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Environment Agency daily values run 09:00 to 09:00 GMT (= UTC) and carry the start date (replay daily_note). */
export const EA_DAY_START_UTC_HOUR = 9;

export interface SpillInterval {
  readonly startMs: number;
  readonly stopMs: number; // exclusive
}

export interface OverflowTrack {
  readonly key: string;
  readonly name: string;
  readonly siteIds: readonly string[];
  readonly lat: number;
  readonly lon: number;
  readonly receivingWater: string | null;
  /** Along-river distance from the overflow to the weir (OpenStreetMap), metres; null when the pipeline could not route it. */
  readonly distanceToWeirM: number | null;
  readonly intervals: readonly SpillInterval[];
}

export interface TimelineEvent {
  readonly tMs: number;
  readonly kind: 'on' | 'off';
  readonly overflow: string;
}

export interface TimelineSample {
  readonly tMs: number;
  readonly timeLocal: string;
  readonly ecoliPer100ml: number;
  readonly enterococciPer100ml: number | null;
  readonly over900: boolean;
}

export interface DailyValue {
  readonly date: string;
  /** The UTC period the value covers: [date 09:00 UTC, date+1 09:00 UTC). */
  readonly startMs: number;
  readonly endMs: number;
  readonly value: number | null;
  readonly quality: string;
  readonly gauge: string;
}

export interface ReplayTimeline {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly site: ReplayFile['site'];
  readonly overflows: readonly OverflowTrack[];
  readonly events: readonly TimelineEvent[];
  readonly samples: readonly TimelineSample[];
  readonly flow: readonly DailyValue[];
  readonly rain: readonly DailyValue[];
}

export function mergeIntervals(spans: readonly SpillInterval[]): SpillInterval[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
  const out: { startMs: number; stopMs: number }[] = [];
  for (const s of sorted) {
    if (s.stopMs < s.startMs) throw new Error(`spill interval ends before it starts: ${JSON.stringify(s)}`);
    const last = out[out.length - 1];
    if (last && s.startMs <= last.stopMs) last.stopMs = Math.max(last.stopMs, s.stopMs);
    else out.push({ startMs: s.startMs, stopMs: s.stopMs });
  }
  return out;
}

const eaPeriod = (date: string): { startMs: number; endMs: number } => {
  const startMs = parseUtc(`${date}T${String(EA_DAY_START_UTC_HOUR).padStart(2, '0')}:00:00Z`);
  return { startMs, endMs: startMs + DAY_MS };
};

const daily = <T extends FlowDay | RainDay>(rows: readonly T[], pick: (r: T) => number | null): DailyValue[] => {
  const out = rows.map((r) => ({ date: r.date, ...eaPeriod(r.date), value: pick(r), quality: r.quality, gauge: r.gauge }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    if (out[i]!.startMs !== prev.endMs) throw new Error(`daily values are not consecutive: ${prev.date} then ${out[i]!.date}`);
  }
  return out;
};

export function buildTimeline(pack: ReplayFile): ReplayTimeline {
  const windowStartMs = parseUtc(pack.window_utc[0]);
  const windowEndMs = parseUtc(pack.window_utc[1]);
  if (windowEndMs <= windowStartMs) throw new Error(`replay window is empty: ${pack.window_utc.join(' to ')}`);

  const overflows: OverflowTrack[] = pack.overflows.map((o) => ({
    key: o.overflow,
    name: o.name,
    siteIds: o.site_ids,
    lat: o.lat,
    lon: o.lon,
    receivingWater: o.receiving_water,
    distanceToWeirM: o.distance_to_weir_m,
    intervals: mergeIntervals(o.events.map((e) => ({ startMs: parseUtc(e.start_utc), stopMs: parseUtc(e.stop_utc) }))),
  }));
  const keys = new Set(overflows.map((o) => o.key));
  if (keys.size !== overflows.length) throw new Error('replay lists the same overflow twice');

  const events: TimelineEvent[] = overflows.flatMap((o) =>
    o.intervals.flatMap((iv) => [
      { tMs: iv.startMs, kind: 'on' as const, overflow: o.key },
      { tMs: iv.stopMs, kind: 'off' as const, overflow: o.key },
    ]),
  );
  // Time order; at the same instant an overflow switching off comes before one switching on, then by name.
  events.sort((a, b) => a.tMs - b.tMs || (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) || a.overflow.localeCompare(b.overflow));

  const samples: TimelineSample[] = pack.samples
    .map((s) => ({
      tMs: parseUtc(s.time_utc),
      timeLocal: s.time_local,
      ecoliPer100ml: s.ecoli_per_100ml,
      enterococciPer100ml: s.enterococci_per_100ml,
      over900: s.over_900,
    }))
    .sort((a, b) => a.tMs - b.tMs);

  return {
    windowStartMs,
    windowEndMs,
    site: pack.site,
    overflows,
    events,
    samples,
    flow: daily(pack.flow_daily, (r) => r.m3_per_s),
    rain: daily(pack.rain_daily, (r) => r.mm),
  };
}

/** The spill interval of one overflow that contains t, or null. Intervals are [start, stop). */
export function activeInterval(track: OverflowTrack, tMs: number): SpillInterval | null {
  return track.intervals.find((iv) => iv.startMs <= tMs && tMs < iv.stopMs) ?? null;
}

/** Keys of the overflows spilling at t. */
export const spillingAt = (tl: ReplayTimeline, tMs: number): string[] =>
  tl.overflows.filter((o) => activeInterval(o, tMs) !== null).map((o) => o.key);

/** Overflows with at least one spill overlapping the replay window. */
export const overflowsSpillingInWindow = (tl: ReplayTimeline): OverflowTrack[] =>
  tl.overflows.filter((o) => o.intervals.some((iv) => iv.stopMs > tl.windowStartMs && iv.startMs < tl.windowEndMs));

/** The daily value whose 09:00-09:00 UTC period contains t, or null when t is outside every period. */
export const dailyAt = (rows: readonly DailyValue[], tMs: number): DailyValue | null =>
  rows.find((r) => r.startMs <= tMs && tMs < r.endMs) ?? null;

export const hoursBetween = (aMs: number, bMs: number): number => (bMs - aMs) / HOUR_MS;
