// The city scene's data: every waterway and every chained stream, with the state at each vertex and the
// field of hours under a stream (the forecast's whole horizon, up to 168 hours), all from the along-stream rule (src/model/alongStream.ts) over CityState.
// No DOM here; the scene projects and draws what this module computes.
import type { ChainedStream, PackWay, StreamPackFile } from '../data/schemas';
import type { FogState } from '../engine/fog';
import { guessOf, pointOnNetwork, pointOnStream, type Guess, type SiteSeries, type Station } from '../model/alongStream';
import type { CityState, FullSeries } from '../model/cityState';
import { siteDisplayName, streamDisplayName } from '../model/names';
import { streamMoment, type Moment } from '../model/sentence';
import { localProj, slug, type LocalProj } from './util';

export const GUESS_INDEX: Record<Guess, number> = { usual: 0, higher: 1, high: 2 };
export const STATE_INDEX: Record<FogState, number> = { usual: 0, higher: 1, high: 2, unknown: 3 };
export const STATES: readonly FogState[] = ['usual', 'higher', 'high', 'unknown'];
/** The strip runs from its first hour to the forecast's end, at most a week (the quests may lie days ahead). */
export const MAX_SPAN_H = 168;
export const NX = 240;

type LL = readonly [number, number];

export interface Way {
  readonly id: number;
  readonly idx: number;
  readonly kind: PackWay['kind'];
  readonly c: readonly LL[];
  readonly n: number;
  readonly cd: Float64Array; // cumulative metres
  readonly L: number;
  readonly site: readonly (string | null)[];
  readonly S: Float32Array;
  readonly chain: number;
  readonly km: Float32Array | null;
  readonly guess: Uint8Array;
  readonly unk: Uint8Array;
  readonly fog: Float32Array;
  /** The chance of a sample over the flag at each vertex (probabilityColour colours it). */
  readonly p50: Float32Array;
  readonly P: Float32Array;
  readonly E: Float32Array;
  vis: boolean;
  pm: number;
}

export interface Chain {
  readonly ci: number;
  /** The name as the pack gives it (the link's slug comes from it). */
  readonly name: string;
  /** The name as the screen shows it (src/model/names.ts). */
  readonly display: string;
  readonly slug: string;
  readonly line: readonly LL[];
  readonly km: Float64Array;
  readonly L: number;
  readonly n: number;
  /** `name` is the site record's; `display` the readable one on this stream (src/model/names.ts). */
  readonly stations: readonly (Station & { readonly name: string; readonly display: string; readonly index: number })[];
  readonly ids: ReadonlySet<number>;
  readonly guess: Uint8Array;
  readonly unk: Uint8Array;
  readonly p50: Float32Array;
  readonly fog: Float32Array;
  readonly P: Float32Array;
  readonly E: Float32Array;
}

/** The field under a stream: nt rows (hours from the base hour, 0 .. span) x NX columns (km). */
export interface Field {
  readonly baseHour: number;
  readonly nt: number;
  readonly p50: Float32Array;
  readonly fog: Float32Array;
  readonly guess: Uint8Array;
  readonly state: Uint8Array;
}

export interface CityGeometry {
  readonly proj: LocalProj;
  readonly ways: Way[];
  readonly chains: Chain[];
  /** Every vertex carries its ground elevation from the pack (build_streams.py), in metres. */
  readonly baked: boolean;
}

export function buildGeometry(pack: StreamPackFile): CityGeometry {
  const proj = localProj(pack.center[1]);
  const codes = pack.sites.map((s) => s.code);
  const chains: Chain[] = pack.streams.map((s: ChainedStream, ci) => {
    const n = s.line.length;
    const display = streamDisplayName(s.name, s.stations.map((st) => st.name));
    return {
      ci,
      name: s.name,
      display,
      slug: slug(s.name),
      line: s.line,
      km: Float64Array.from(s.km),
      L: s.length_km,
      n,
      stations: s.stations.map((st, index) => ({ code: st.code, name: st.name, display: siteDisplayName(st.name, display), km: st.km, index })),
      ids: new Set(s.osm_ids),
      guess: new Uint8Array(n),
      unk: new Uint8Array(n),
      p50: new Float32Array(n),
      fog: new Float32Array(n),
      P: new Float32Array(2 * n),
      E: s.E ? Float32Array.from(s.E) : new Float32Array(n),
    };
  });
  const ways: Way[] = pack.ways.map((w, idx) => {
    const n = w.c.length;
    const cd = new Float64Array(n);
    for (let k = 1; k < n; k++) cd[k] = cd[k - 1]! + proj.d(w.c[k - 1]!, w.c[k]!);
    return {
      id: w.id,
      idx,
      kind: w.kind,
      c: w.c,
      n,
      cd,
      L: cd[n - 1]!,
      site: w.site.map((k) => (k >= 0 ? codes[k]! : null)),
      S: Float32Array.from(w.S),
      chain: w.chain ?? -1,
      km: w.km ? Float32Array.from(w.km) : null,
      guess: new Uint8Array(n),
      unk: new Uint8Array(n),
      fog: new Float32Array(n),
      p50: new Float32Array(n),
      P: new Float32Array(2 * n),
      E: w.E ? Float32Array.from(w.E) : new Float32Array(n),
      vis: false,
      pm: 0,
    };
  });
  const baked = pack.streams.every((s) => s.E !== undefined) && pack.ways.every((w) => w.E !== undefined) && pack.sites.every((s) => s.E !== undefined);
  return { proj, ways, chains, baked };
}

const UNMEASURED: SiteSeries = { p50: [0], fog: [1] };

/**
 * Updates every vertex's chance, best guess, unknown flag and fog at hour h. `series` may stand in for the city's
 * own (the screen holding the state from before a test reading).
 */
export function evalNetwork(g: CityGeometry, cs: CityState, h: number, series: (code: string) => SiteSeries = (c) => cs.series(c)): void {
  const t = cs.thresholds;
  for (const w of g.ways) {
    if (w.kind === 'river') continue;
    const ch = w.chain >= 0 ? g.chains[w.chain]! : null;
    let ps = 0;
    for (let k = 0; k < w.n; k++) {
      const code = w.site[k];
      const p = ch && w.km ? pointOnStream(ch.stations, series, w.km[k]!, h, t) : pointOnNetwork(code ? series(code) : UNMEASURED, code ? w.S[k]! : 0, h, t);
      w.guess[k] = GUESS_INDEX[p.guess];
      w.unk[k] = p.state === 'unknown' ? 1 : 0;
      w.fog[k] = p.fog;
      w.p50[k] = p.p50;
      ps += p.p50;
    }
    w.pm = ps / w.n;
  }
  for (const ch of g.chains) {
    for (let k = 0; k < ch.n; k++) {
      const p = pointOnStream(ch.stations, series, ch.km[k]!, h, t);
      ch.guess[k] = GUESS_INDEX[p.guess];
      ch.unk[k] = p.state === 'unknown' ? 1 : 0;
      ch.p50[k] = p.p50;
      ch.fog[k] = p.fog;
    }
  }
}

/** An empty field under a stream from base hour hb (rows hb .. hb + span), to fill with fillFieldRows. */
export function emptyField(hb: number, span: number): Field {
  const nt = span + 1;
  return { baseHour: hb, nt, p50: new Float32Array(NX * nt), fog: new Float32Array(NX * nt), guess: new Uint8Array(NX * nt), state: new Uint8Array(NX * nt) };
}

/** Fills rows [it0, it1) of a field (the scene fills a long strip a few rows per frame). */
export function fillFieldRows(f: Field, ch: Chain, cs: CityState, it0: number, it1: number, series: (code: string) => SiteSeries = (c) => cs.series(c)): void {
  const t = cs.thresholds;
  for (let it = it0; it < Math.min(it1, f.nt); it++)
    for (let ix = 0; ix < NX; ix++) {
      const p = pointOnStream(ch.stations, series, (ix / (NX - 1)) * ch.L, f.baseHour + it, t);
      const i = it * NX + ix;
      f.p50[i] = p.p50;
      f.fog[i] = p.fog;
      f.guess[i] = GUESS_INDEX[p.guess];
      f.state[i] = STATE_INDEX[p.state];
    }
}

/** The field under a stream from base hour hb (rows hb .. hb + span). */
export function computeField(ch: Chain, cs: CityState, hb: number, span: number, series: (code: string) => SiteSeries = (c) => cs.series(c)): Field {
  const f = emptyField(hb, span);
  fillFieldRows(f, ch, cs, 0, f.nt, series);
  return f;
}

/** The stream's timeline over the strip's hours (for the sentence), from its stations. */
export function streamTimeline(ch: Chain, cs: CityState, hb: number, span: number): Moment[] {
  const out: Moment[] = [];
  const t = cs.thresholds;
  for (let r = 0; r <= span; r++) {
    const h = Math.min(hb + r, cs.hoursMs.length - 1);
    const st = ch.stations.map((s) => {
      const ser = cs.series(s.code);
      return { state: ser.state[h]!, guess: guessOf(ser.p50[h]!, t), rainMm: cs.rainMm(s.code, h) };
    });
    out.push(streamMoment(cs.hoursMs[h]!, st));
  }
  return out;
}

/** The state at a station at hour h (the figures and the lamps read it); `s` may stand in for the site's own series. */
export function stationAt(cs: CityState, code: string, h: number, s: FullSeries = cs.series(code)): { state: FogState; guess: Guess; p50: number; fog: number; rainMm: number } {
  const hi = Math.round(Math.max(0, Math.min(cs.hoursMs.length - 1, h)));
  return { state: s.state[hi]!, guess: guessOf(s.p50[hi]!, cs.thresholds), p50: s.p50[hi]!, fog: s.fog[hi]!, rainMm: cs.rainMm(code, hi) };
}

/**
 * Whether a forecast covers the instant `ms` (live), and the "now" the city shows: `ms` itself when live;
 * otherwise the forecast's own first hour, so an old forecast is shown as what it was (dated), never as today,
 * and a clock before the forecast never shows its first hour as now.
 */
export function forecastNow(hoursMs: readonly number[], ms: number): { live: boolean; nowMs: number } {
  const first = hoursMs[0]!;
  const last = hoursMs[hoursMs.length - 1]!;
  const live = ms >= first && ms < last + 3.6e6;
  return { live, nowMs: live ? ms : first };
}

/** The hour the strip starts at: the clock's hour (the strip ends where the forecast ends, see stripRows). */
export const stripBaseHour = (cs: CityState, ms: number): number => Math.max(0, Math.min(cs.hoursMs.length - 1, Math.floor(cs.hourOf(ms))));
/** The strip's span: hours after its first row that the forecast reaches, at most MAX_SPAN_H. */
export const stripRows = (cs: CityState, hb: number): number => Math.max(0, Math.min(MAX_SPAN_H, cs.hoursMs.length - 1 - hb));
