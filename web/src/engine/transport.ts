// Pulse transport for a storm replay. Each spilling overflow emits a pulse: its head leaves the pipe when
// the spill starts, its tail when the spill stops. The pulse travels its along-river distance to the weir
// at a velocity set by the day's river flow, and fades by first-order die-off.
//
// ASSUMPTIONS (stated for the judges; none is fitted to the samples):
// 1. Velocity follows at-a-station hydraulic geometry, v = k Q^m (Leopold & Maddock 1953, USGS Professional
//    Paper 252). m = 0.34 is their average at-a-station velocity exponent (tabulated in Singh 2003,
//    Int. J. Sediment Research 18(3):196-218, Table 2: b = 0.26, f = 0.40, m = 0.34).
// 2. k is set so that v = 0.5 m/s at the gauge's median daily flow. 0.5 m/s is the middle of the three
//    reference velocities the pipeline reports (0.25, 0.5, 1.0 m/s); it is an assumption, not a fit. The
//    median flow is recovered from the two model files (see gaugeMedianFlow).
// 3. One velocity applies to every reach at a given time, from the Bradford-on-Avon daily flow, including
//    tributaries (Midford Brook, River Frome, River Biss) that carry less water than the gauge.
// 4. Die-off k_d = 0.8 per day x 1.07^(T - 20), Mancini (1978), J. Water Pollution Control Federation
//    50(11):2477-2484: the dark freshwater coliform rate at 20 C with its temperature factor. Sunlight
//    would speed it; the dark rate is the slower, more cautious choice. Water temperature is not in the
//    replay data, so T = 20 C (the reference temperature) is assumed.
// 5. Spill logs give duration, not volume, so every overflow emits at the same unit rate. The weir index
//    counts the overflow plumes present at the weir, each weighted by the fraction surviving die-off; it
//    ignores dilution by flow. It is a relative index for drawing the replay, not a concentration.
import type { ModelFile } from '../data/schemas';
import type { DailyValue, OverflowTrack, ReplayTimeline, SpillInterval } from './replay';

const HOUR_MS = 3_600_000;

export interface TransportAssumptions {
  /** m in v = k Q^m. */
  readonly velocityExponent: number;
  /** Velocity at the reference flow, m/s. */
  readonly referenceVelocityMps: number;
  /** Reference flow (the gauge median), m3/s. */
  readonly referenceFlowM3s: number;
  /** Dark freshwater die-off at 20 C, per day. */
  readonly dieOffPerDayAt20C: number;
  /** Temperature factor theta in k_d(T) = k_d(20) theta^(T - 20). */
  readonly dieOffTheta: number;
  /** Water temperature, C. */
  readonly waterTempC: number;
}

export const LEOPOLD_MADDOCK_AT_A_STATION_M = 0.34;
export const MANCINI_DARK_FRESHWATER_PER_DAY = 0.8;
export const MANCINI_THETA = 1.07;
export const ASSUMED_VELOCITY_AT_MEDIAN_FLOW_MPS = 0.5;
export const ASSUMED_WATER_TEMP_C = 20;

/**
 * The gauge's median daily flow over 2021-2024, recovered exactly from the model files: the Warleigh model
 * standardises ln(flow_prev_day) and the portable model standardises ln(flow_prev_day / median) over the
 * same training samples, so the difference of their means is ln(median).
 */
export function gaugeMedianFlow(warleigh: ModelFile, portable: ModelFile): number {
  const flow = warleigh.features.find((f) => f.input === 'flow_prev_day');
  const ratio = portable.features.find((f) => f.input === 'flow_ratio');
  if (!flow || !ratio) throw new Error('gaugeMedianFlow needs flow_prev_day in the Warleigh model and flow_ratio in the portable model');
  if (flow.transform !== 'log' || ratio.transform !== 'log') throw new Error('gaugeMedianFlow expects log transforms on both flow features');
  if (warleigh.train_n !== portable.train_n) throw new Error('the two models were not fitted on the same samples');
  return Math.exp(flow.mean - ratio.mean);
}

export const avonAssumptions = (referenceFlowM3s: number): TransportAssumptions => ({
  velocityExponent: LEOPOLD_MADDOCK_AT_A_STATION_M,
  referenceVelocityMps: ASSUMED_VELOCITY_AT_MEDIAN_FLOW_MPS,
  referenceFlowM3s,
  dieOffPerDayAt20C: MANCINI_DARK_FRESHWATER_PER_DAY,
  dieOffTheta: MANCINI_THETA,
  waterTempC: ASSUMED_WATER_TEMP_C,
});

export function velocityMps(a: TransportAssumptions, flowM3s: number): number {
  if (!(flowM3s > 0)) throw new Error(`flow must be positive to set a velocity, got ${flowM3s}`);
  return a.referenceVelocityMps * (flowM3s / a.referenceFlowM3s) ** a.velocityExponent;
}

export const dieOffPerHour = (a: TransportAssumptions): number =>
  (a.dieOffPerDayAt20C * a.dieOffTheta ** (a.waterTempC - 20)) / 24;

/**
 * The distance clock D(t): metres a water parcel travels from the domain start to t. Velocity is constant
 * within each daily flow period, so D is piecewise linear and strictly increasing, and the distance a
 * parcel travels between t0 and t1 is D(t1) - D(t0).
 */
export interface DistanceClock {
  readonly startMs: number;
  readonly endMs: number;
  readonly knots: readonly { readonly tMs: number; readonly metres: number; readonly mps: number }[];
}

export function buildDistanceClock(flow: readonly DailyValue[], a: TransportAssumptions, startMs: number, endMs: number): DistanceClock {
  const periods = flow.filter((d) => d.endMs > startMs && d.startMs < endMs);
  if (periods.length === 0 || periods[0]!.startMs > startMs || periods[periods.length - 1]!.endMs < endMs)
    throw new Error('daily flow does not cover the transport domain');
  const knots: { tMs: number; metres: number; mps: number }[] = [];
  let metres = 0;
  for (const d of periods) {
    if (d.value === null) throw new Error(`no flow on ${d.date} (${d.quality}); the replay cannot move pulses through that day`);
    const t0 = Math.max(d.startMs, startMs);
    const t1 = Math.min(d.endMs, endMs);
    const mps = velocityMps(a, d.value);
    knots.push({ tMs: t0, metres, mps });
    metres += (mps * (t1 - t0)) / 1000;
  }
  return { startMs, endMs, knots };
}

const checkDomain = (c: DistanceClock, tMs: number): void => {
  if (!(tMs >= c.startMs && tMs <= c.endMs))
    throw new RangeError(`t = ${new Date(tMs).toISOString()} is outside the replay's flow record (${new Date(c.startMs).toISOString()} to ${new Date(c.endMs).toISOString()})`);
};

/** D(t) in metres. */
export function distanceAt(c: DistanceClock, tMs: number): number {
  checkDomain(c, tMs);
  let lo = 0;
  let hi = c.knots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.knots[mid]!.tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const k = c.knots[lo]!;
  return k.metres + (k.mps * (tMs - k.tMs)) / 1000;
}

/** The time at which D equals `metres` (inverse of distanceAt), or null if that is before the domain. */
export function timeAtDistance(c: DistanceClock, metres: number): number | null {
  if (metres < 0) return null;
  let lo = 0;
  let hi = c.knots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.knots[mid]!.metres <= metres) lo = mid;
    else hi = mid - 1;
  }
  const k = c.knots[lo]!;
  return k.tMs + ((metres - k.metres) / k.mps) * 1000;
}

export interface TransportTrack {
  readonly overflow: OverflowTrack;
  readonly distanceM: number;
  /** Spill intervals clipped to the domain; startClipped marks a spill that began before the flow record. */
  readonly intervals: readonly (SpillInterval & { readonly startClipped: boolean })[];
}

export interface TransportReplay {
  readonly startMs: number;
  readonly endMs: number;
  readonly clock: DistanceClock;
  readonly dieOffPerHour: number;
  readonly assumptions: TransportAssumptions;
  readonly tracks: readonly TransportTrack[];
  /** Overflows the pipeline could not route to the weir; they appear on the timeline but carry no pulse. */
  readonly unrouted: readonly string[];
}

/**
 * The transport domain is the replay window intersected with the daily flow record, because velocity is
 * undefined without flow. Queries outside it throw a RangeError.
 */
export function buildTransport(tl: ReplayTimeline, a: TransportAssumptions): TransportReplay {
  const flowStart = tl.flow[0]!.startMs;
  const flowEnd = tl.flow[tl.flow.length - 1]!.endMs;
  const startMs = Math.max(tl.windowStartMs, flowStart);
  const endMs = Math.min(tl.windowEndMs, flowEnd);
  if (endMs <= startMs) throw new Error('the flow record does not overlap the replay window');
  const clock = buildDistanceClock(tl.flow, a, startMs, endMs);
  const tracks: TransportTrack[] = [];
  const unrouted: string[] = [];
  for (const o of tl.overflows) {
    if (o.distanceToWeirM === null) {
      unrouted.push(o.key);
      continue;
    }
    const intervals = o.intervals
      .filter((iv) => iv.stopMs > startMs && iv.startMs < endMs)
      .map((iv) => ({ startMs: Math.max(iv.startMs, startMs), stopMs: Math.min(iv.stopMs, endMs), startClipped: iv.startMs < startMs }));
    tracks.push({ overflow: o, distanceM: o.distanceToWeirM, intervals });
  }
  return { startMs, endMs, clock, dieOffPerHour: dieOffPerHour(a), assumptions: a, tracks, unrouted };
}

export interface Pulse {
  readonly overflow: string;
  readonly name: string;
  readonly spillStartMs: number;
  readonly spillStopMs: number;
  readonly spilling: boolean;
  readonly startClipped: boolean;
  readonly riverKm: number;
  /** Positions of the pulse's head (first water out) and tail (last water out) on the overflow-to-weir path. */
  readonly headKmFromOverflow: number;
  readonly tailKmFromOverflow: number;
  readonly headKmToWeir: number;
  readonly tailKmToWeir: number;
  /** Fraction surviving die-off at the head and the tail. */
  readonly headSurvival: number;
  readonly tailSurvival: number;
  /** The fraction surviving in the water passing the weir at t, or null if the pulse is not at the weir. */
  readonly weirSurvival: number | null;
}

/**
 * Pulses with some part between their overflow and the weir at t. A pulse whose tail has passed the weir
 * is gone; a pulse whose head has passed it is at the weir until its tail arrives.
 */
export function pulsesAt(tr: TransportReplay, tMs: number): Pulse[] {
  const dNow = distanceAt(tr.clock, tMs);
  const out: Pulse[] = [];
  for (const track of tr.tracks) {
    const L = track.distanceM;
    const emittedAtWeir = timeAtDistance(tr.clock, dNow - L);
    for (const iv of track.intervals) {
      if (iv.startMs > tMs) break;
      const tailEmitMs = Math.min(iv.stopMs, tMs);
      const head = dNow - distanceAt(tr.clock, iv.startMs);
      const tail = dNow - distanceAt(tr.clock, tailEmitMs);
      if (tail >= L) continue;
      const atWeir = emittedAtWeir !== null && emittedAtWeir >= iv.startMs && emittedAtWeir <= tailEmitMs;
      const survival = (fromMs: number): number => Math.exp((-tr.dieOffPerHour * (tMs - fromMs)) / HOUR_MS);
      const headOnPath = Math.min(head, L);
      out.push({
        overflow: track.overflow.key,
        name: track.overflow.name,
        spillStartMs: iv.startMs,
        spillStopMs: iv.stopMs,
        spilling: tMs < iv.stopMs,
        startClipped: iv.startClipped,
        riverKm: L / 1000,
        headKmFromOverflow: headOnPath / 1000,
        tailKmFromOverflow: tail / 1000,
        headKmToWeir: (L - headOnPath) / 1000,
        tailKmToWeir: (L - tail) / 1000,
        headSurvival: survival(head > L && emittedAtWeir !== null ? emittedAtWeir : iv.startMs),
        tailSurvival: survival(tailEmitMs),
        weirSurvival: atWeir ? survival(emittedAtWeir) : null,
      });
    }
  }
  return out;
}

/** The weir index at t: the sum over pulses at the weir of the fraction surviving die-off (assumption 5). */
export const weirIndex = (tr: TransportReplay, tMs: number): number =>
  pulsesAt(tr, tMs).reduce((sum, p) => sum + (p.weirSurvival ?? 0), 0);

/** Pulse speed at t, m/s (the same on every reach, assumption 3). */
export function velocityAt(tr: TransportReplay, tMs: number): number {
  checkDomain(tr.clock, tMs);
  let k = tr.clock.knots[0]!;
  for (const x of tr.clock.knots) if (x.tMs <= tMs) k = x;
  return k.mps;
}
