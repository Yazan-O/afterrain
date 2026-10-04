// The along-stream rule: what the app says at any point of a stream, from the OneAquaHealth sites on it.
//
// A stream is a line from its source (km 0) to its mouth; its stations are the sites snapped to it, each at a
// km position. At a point x km along the stream and an hour h:
//   chance (p50)  the nearest station upstream of or at x gives its median chance of over 900 E. coli per 100 ml.
//                 Between two stations the chance is interpolated linearly by position; above the first
//                 station (no station upstream) the first station downstream gives it.
//   travel        beyond the stations the water carries the nearest station's state at FLOW_KMH: below the last
//                 station the water at x passed it (x - km) / FLOW_KMH hours ago; above the first, it reaches it
//                 (km - x) / FLOW_KMH hours later. Between two stations both are read at the same hour (each
//                 station's own forecast already holds the rain that reaches it). A storm is a band that arrives
//                 upstream first and leaves the mouth last. FLOW_KMH is 0.5 m/s, the median-flow speed the storm
//                 replay's transport assumes for the Avon (src/engine/transport.ts header): an assumption, not a gauge.
//   fog           the station fog (interpolated the same way) rises with the along-stream distance d to the
//                 nearest station: fog = 1 - (1 - fog_station) * exp(-d / FOG_KM). At a station the fog is the
//                 station's own; 3 km away, about two thirds of the remaining certainty is gone.
//   state         "unknown" when fog >= the nowcast's unknown_fog threshold; otherwise high / higher / usual by
//                 the chance against the nowcast's thresholds, exactly as the pipeline states a site.
//   best guess    the same chance classified without the fog test: the colour drawn faintly through the fog.
// Waterways that are not a chained stream use the network-nearest site with the network distance as d.
import type { FogState } from '../engine/fog';

export const FOG_KM = 3;
/** How fast the water carries a station's state downstream: 0.5 m/s (see the header). */
export const FLOW_KMH = 1.8;

export type Guess = Exclude<FogState, 'unknown'>;

export interface Thresholds {
  readonly higher: number;
  readonly high: number;
  readonly unknown_fog: number;
}

export interface Station {
  readonly code: string;
  readonly km: number;
}

/** A site's hourly series, index = hour since the nowcast's first hour. */
export interface SiteSeries {
  readonly p50: ArrayLike<number>;
  readonly fog: ArrayLike<number>;
}

export interface PointState {
  readonly p50: number;
  readonly fog: number;
  readonly state: FogState;
  readonly guess: Guess;
}

export const guessOf = (p50: number, t: Thresholds): Guess => (p50 >= t.high ? 'high' : p50 >= t.higher ? 'higher' : 'usual');

export const stateOf = (p50: number, fog: number, t: Thresholds): FogState => (fog >= t.unknown_fog ? 'unknown' : guessOf(p50, t));

/** Fog at distance dKm from a point whose own fog is fogAt. */
export const fogWithDistance = (fogAt: number, dKm: number): number => 1 - (1 - fogAt) * Math.exp(-Math.max(0, dKm) / FOG_KM);

/** Linear interpolation of an hourly series at a fractional hour (clamped to the series). */
export function atHour(v: ArrayLike<number>, h: number): number {
  const n = v.length;
  if (n === 0) throw new Error('empty series');
  if (h <= 0) return v[0]!;
  if (h >= n - 1) return v[n - 1]!;
  const i = Math.floor(h);
  const f = h - i;
  return v[i]! + (v[i + 1]! - v[i]!) * f;
}

/**
 * The state at km x and hour h of a stream. `stations` must be sorted by km and have a series each.
 */
export function pointOnStream(
  stations: readonly Station[],
  series: (code: string) => SiteSeries,
  x: number,
  h: number,
  t: Thresholds,
): PointState {
  if (stations.length === 0) throw new Error('a stream needs at least one station');
  let up = -1;
  for (let i = 0; i < stations.length; i++) if (stations[i]!.km <= x) up = i;
  const down = up + 1 < stations.length ? up + 1 : -1;
  let p50: number;
  let fogSt: number;
  if (up >= 0 && down >= 0) {
    const a = stations[up]!;
    const b = stations[down]!;
    const w = b.km > a.km ? (x - a.km) / (b.km - a.km) : 0;
    const sa = series(a.code);
    const sb = series(b.code);
    p50 = (1 - w) * atHour(sa.p50, h) + w * atHour(sb.p50, h);
    fogSt = (1 - w) * atHour(sa.fog, h) + w * atHour(sb.fog, h);
  } else {
    const st = stations[up >= 0 ? up : 0]!;
    const s = series(st.code);
    const hs = h - (x - st.km) / FLOW_KMH;
    p50 = atHour(s.p50, hs);
    fogSt = atHour(s.fog, hs);
  }
  let d = Infinity;
  for (const s of stations) d = Math.min(d, Math.abs(x - s.km));
  const fog = fogWithDistance(fogSt, d);
  return { p50, fog, state: stateOf(p50, fog, t), guess: guessOf(p50, t) };
}

/** The state at a network vertex that is not on a chained stream: its network-nearest site, dKm away. */
export function pointOnNetwork(s: SiteSeries, dKm: number, h: number, t: Thresholds): PointState {
  const p50 = atHour(s.p50, h);
  const fog = fogWithDistance(atHour(s.fog, h), dKm);
  return { p50, fog, state: stateOf(p50, fog, t), guess: guessOf(p50, t) };
}
