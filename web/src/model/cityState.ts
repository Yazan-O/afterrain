// A city's sites hour by hour, recomputed in the browser from the same inputs the nowcast used, so a citizen
// sample can change them. Each site starts at the prior (no OneAquaHealth site has an E. coli count in the
// public API, which is why the nowcast starts every site there too); a sample updates that site's posterior
// through src/engine/fog.ts, and its hours are recomputed from the ensemble members' rain.
import type { NowcastFile, StreamPackFile, UpdateSpecFile } from '../data/schemas';
import { applySample, hourSummary, moments, predictive, prior, quantileSorted, rainInput, type FogState, type Observation, type Posterior, type SampleUpdate } from '../engine/fog';
import type { SiteSeries, Thresholds } from './alongStream';

export interface FullSeries extends SiteSeries {
  readonly p10: Float64Array;
  readonly p50: Float64Array;
  readonly p90: Float64Array;
  readonly fog: Float64Array;
  readonly state: FogState[];
}

export interface TestSampleResult {
  readonly code: string;
  readonly hour: number;
  readonly before: FullSeries;
  readonly after: FullSeries;
  readonly update: SampleUpdate;
}

export class CityState {
  readonly hoursMs: readonly number[];
  readonly thresholds: Thresholds;
  private readonly xs: number[][][]; // per cell, per hour, sorted member x
  private readonly cellOf = new Map<string, number>();
  private readonly posts = new Map<string, Posterior>();
  private readonly cache = new Map<string, FullSeries>();
  private readonly priorPost: Posterior;
  private readonly updates = new Map<string, SampleUpdate[]>();
  private readonly rain = new Map<number, Float64Array>();
  private version = 0;

  constructor(
    private readonly spec: UpdateSpecFile,
    readonly pack: StreamPackFile,
    readonly nowcast: NowcastFile,
  ) {
    if (pack.hours_utc.join() !== nowcast.hours_utc.join()) throw new Error(`streams/${pack.city}.json hours do not match nowcast_${pack.city}.json`);
    this.hoursMs = nowcast.hours_utc.map((h) => Date.parse(h));
    const t = nowcast.thresholds;
    this.thresholds = t ?? { higher: spec.params.t_higher, high: spec.params.t_high, unknown_fog: spec.params.fog_unknown };
    this.xs = pack.cells.map((c) => c.r48_mm.map((hour) => hour.map(rainInput).sort((a, b) => a - b)));
    pack.cells.forEach((c, i) => c.sites.forEach((code) => this.cellOf.set(code, i)));
    this.priorPost = prior(spec);
  }

  /** Bumps whenever a sample changes any site (drawing code uses it to know when to recompute). */
  get revision(): number {
    return this.version;
  }

  hasSample(code: string): boolean {
    return (this.updates.get(code)?.length ?? 0) > 0;
  }

  /** Fractional hour index of an instant (0 = the nowcast's first hour), clamped to the nowcast. */
  hourOf(ms: number): number {
    const h0 = this.hoursMs[0]!;
    return Math.max(0, Math.min(this.hoursMs.length - 1, (ms - h0) / 3.6e6));
  }

  /** Rain forecast for the 48 hours before hour h at the site's forecast cell, mm: the median over the members. */
  rainMm(code: string, h: number): number {
    const cell = this.cellOf.get(code);
    if (cell === undefined) throw new Error(`site ${code} has no forecast cell in streams/${this.pack.city}.json`);
    let r = this.rain.get(cell);
    if (!r) {
      r = Float64Array.from(this.xs[cell]!, (xs) => Math.expm1(quantileSorted(xs, 0.5)));
      this.rain.set(cell, r);
    }
    return r[Math.round(Math.max(0, Math.min(r.length - 1, h)))]!;
  }

  series(code: string): FullSeries {
    const hit = this.cache.get(code);
    if (hit) return hit;
    const cell = this.cellOf.get(code);
    if (cell === undefined) throw new Error(`site ${code} has no forecast cell in streams/${this.pack.city}.json`);
    const post = this.posts.get(code);
    const key = post ? code : `prior:${cell}`;
    let s = this.cache.get(key);
    if (!s) {
      s = this.compute(post ?? this.priorPost, this.xs[cell]!);
      this.cache.set(key, s);
    }
    this.cache.set(code, s);
    return s;
  }

  private compute(post: Posterior, xs: number[][]): FullSeries {
    const m = moments(this.spec, post);
    const n = xs.length;
    const out = { p10: new Float64Array(n), p50: new Float64Array(n), p90: new Float64Array(n), fog: new Float64Array(n), state: [] as FogState[] };
    // the predictive chance once per distinct rain input (dry hours share x = 0 across every member)
    const memo = new Map<number, number>();
    const pAt = (x: number): number => {
      let p = memo.get(x);
      if (p === undefined) memo.set(x, (p = predictive(this.spec, m, x)));
      return p;
    };
    for (let h = 0; h < n; h++) {
      const s = hourSummary(this.spec, m, xs[h]!, pAt);
      out.p10[h] = s.p10;
      out.p50[h] = s.p50;
      out.p90[h] = s.p90;
      out.fog[h] = s.fog;
      out.state.push(s.state);
    }
    return out;
  }

  /** A test sample (not a lab result) at site `code`, taken at hour index `hour`. */
  applyTestSample(code: string, hour: number, obs: Observation): TestSampleResult {
    const cell = this.cellOf.get(code);
    if (cell === undefined) throw new Error(`site ${code} is not in this city`);
    const h = Math.round(Math.max(0, Math.min(this.hoursMs.length - 1, hour)));
    const before = this.series(code);
    const x = quantileSorted(this.xs[cell]![h]!, 0.5);
    const r48mm = Math.expm1(x);
    const update = applySample(this.spec, this.posts.get(code) ?? this.priorPost, { r48mm, obs });
    this.posts.set(code, update.after);
    const list = this.updates.get(code) ?? [];
    list.push(update);
    this.updates.set(code, list);
    this.cache.delete(code);
    this.version++;
    return { code, hour: h, before, after: this.series(code), update };
  }

  /** Removes the last test sample at a site. */
  undo(code: string): void {
    const list = this.updates.get(code);
    const last = list?.pop();
    if (!last) return;
    if (last.before === this.priorPost) this.posts.delete(code);
    else this.posts.set(code, last.before);
    this.cache.delete(code);
    this.version++;
  }
}
