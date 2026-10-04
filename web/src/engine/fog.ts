// The citizen-sample update and the fog (spec W5 and section 6), reproduced from
// sayr/data/out/update_spec.json, which the city model exports (pipeline/offsets.py and updatespec.py).
//
// A site's unknown offsets (a, b) live on a fixed grid; the state is the grid's log weights. A sample adds
// its exact log-likelihood to every grid point (Bayes on the grid), so an update is a pure function and
// undoing one is keeping the previous state. From the posterior moments and the rain forecast members,
// an hour gets a probability band (p10, p50, p90), a fog value in [0, 1] and a state word. The chance is the
// posterior predictive (summed over the grid), as the pipeline defines it from 2026-10-02.
import type { UpdateSpecFile } from '../data/schemas';

export const UPDATE_SPEC_FILE = 'update_spec.json';

export type Observation = { readonly over_900: boolean } | { readonly count: number };
export type FogState = 'usual' | 'higher' | 'high' | 'unknown';

/** Unnormalised log weights over the grid, row-major: index i * nB + j for (a_i, b_j). */
export interface Posterior {
  readonly lw: Float64Array;
}

export interface Moments {
  /** The normalised grid weights, row-major like the posterior (the predictive chance sums over them). */
  readonly w: Float64Array;
  readonly meanA: number;
  readonly meanB: number;
  readonly varA: number;
  readonly varB: number;
  readonly covAB: number;
}

export interface HourSummary {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly xMedian: number;
  readonly fogRain: number;
  readonly fogLocal: number;
  readonly fog: number;
  readonly state: FogState;
}

export const softplus = (z: number): number => Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z)));
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
/** The rain input of the model: x = ln(1 + rain over the previous 48 h in mm). */
export const rainInput = (r48mm: number): number => Math.log1p(r48mm);

export function prior(spec: UpdateSpecFile): Posterior {
  const { a, b } = spec.axes;
  const { tau_a, tau_b } = spec.params;
  const lw = new Float64Array(a.length * b.length);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) lw[i * b.length + j] = -((a[i]! ** 2) / (2 * tau_a ** 2) + (b[j]! ** 2) / (2 * tau_b ** 2));
  return { lw };
}

/** log L(obs | eta), exactly as update_spec.json `definitions.update`. */
export function logLikelihood(spec: UpdateSpecFile, obs: Observation, eta: number): number {
  if ('count' in obs) {
    if (!(Number.isFinite(obs.count) && obs.count >= 0)) throw new Error(`a count must be a non-negative number, got ${obs.count}`);
    const u = (Math.log10(Math.max(obs.count, 1)) - spec.params.log10_900) / spec.params.s - eta;
    return -u - 2 * softplus(-u) - Math.log(spec.params.s);
  }
  return obs.over_900 ? -softplus(-eta) : -softplus(eta);
}

/** One sample at rain input x (the member-median x at the sample's hour). Returns a new posterior. */
export function update(spec: UpdateSpecFile, post: Posterior, x: number, obs: Observation): Posterior {
  const { a, b } = spec.axes;
  const { alpha, beta } = spec.params;
  const lw = new Float64Array(post.lw.length);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const k = i * b.length + j;
      lw[k] = post.lw[k]! + logLikelihood(spec, obs, alpha + a[i]! + (beta + b[j]!) * x);
    }
  return { lw };
}

export function moments(spec: UpdateSpecFile, post: Posterior): Moments {
  const { a, b } = spec.axes;
  const nB = b.length;
  let max = -Infinity;
  for (const v of post.lw) if (v > max) max = v;
  const w = new Float64Array(post.lw.length);
  let total = 0;
  for (let k = 0; k < w.length; k++) total += w[k] = Math.exp(post.lw[k]! - max);
  const wa = new Float64Array(a.length);
  const wb = new Float64Array(nB);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < nB; j++) {
      const v = w[i * nB + j]! / total;
      w[i * nB + j] = v;
      wa[i] = wa[i]! + v;
      wb[j] = wb[j]! + v;
    }
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i++) meanA += wa[i]! * a[i]!;
  for (let j = 0; j < nB; j++) meanB += wb[j]! * b[j]!;
  let varA = 0;
  let varB = 0;
  let covAB = 0;
  for (let i = 0; i < a.length; i++) varA += wa[i]! * (a[i]! - meanA) ** 2;
  for (let j = 0; j < nB; j++) varB += wb[j]! * (b[j]! - meanB) ** 2;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < nB; j++) covAB += (a[i]! - meanA) * (b[j]! - meanB) * w[i * nB + j]!;
  return { w, meanA, meanB, varA, varB, covAB };
}

/** exp(-(alpha + a_i)) per grid row, once per spec: sigmoid(eta_ij) = 1 / (1 + exp(-(alpha + a_i)) exp(-(beta + b_j) x)). */
const ROWS = new WeakMap<UpdateSpecFile, Float64Array>();
/**
 * The posterior predictive chance over 900 at rain input x (update_spec.json `definitions.probability`, the
 * 2026-10-02 definition): sum over the grid of w_ij sigmoid(alpha + a_i + (beta + b_j) x).
 */
export function predictive(spec: UpdateSpecFile, m: Moments, x: number): number {
  const { a, b } = spec.axes;
  const nB = b.length;
  let ea = ROWS.get(spec);
  if (!ea) ROWS.set(spec, (ea = Float64Array.from(a, (ai) => Math.exp(-(spec.params.alpha + ai)))));
  const w = m.w;
  let p = 0;
  for (let j = 0; j < nB; j++) {
    const f = Math.exp(-(spec.params.beta + b[j]!) * x);
    for (let i = 0; i < a.length; i++) p += w[i * nB + j]! / (1 + ea[i]! * f);
  }
  return p;
}

/** Linear-interpolation quantile of an ascending array at position (n - 1) q. */
export function quantileSorted(v: readonly number[], q: number): number {
  const n = v.length;
  if (n === 0) throw new Error('quantile of an empty list');
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  if (lo >= n - 1) return v[n - 1]!;
  return v[lo]! + (h - lo) * (v[lo + 1]! - v[lo]!);
}

export function stateOf(spec: UpdateSpecFile, p50: number, fog: number): FogState {
  const { fog_unknown, t_high, t_higher } = spec.params;
  if (fog >= fog_unknown) return 'unknown';
  if (p50 >= t_high) return 'high';
  if (p50 >= t_higher) return 'higher';
  return 'usual';
}

/**
 * Probability band, fog and state at one site-hour; xs are the ensemble members' ln(1 + r48). `pAt` gives the
 * predictive chance at a rain input (a caller summarising many hours of one posterior passes a memo of it).
 */
export function hourSummary(spec: UpdateSpecFile, m: Moments, xs: readonly number[], pAt: (x: number) => number = (x) => predictive(spec, m, x)): HourSummary {
  const { alpha, beta, z90 } = spec.params;
  const x = [...xs].sort((p, q) => p - q);
  const pk = x.map(pAt).sort((p, q) => p - q);
  const [p10, p50, p90] = [0.1, 0.5, 0.9].map((q) => quantileSorted(pk, q)) as [number, number, number];
  const xMedian = quantileSorted(x, 0.5);
  const etaT = alpha + m.meanA + (beta + m.meanB) * xMedian;
  const sdU = Math.sqrt(Math.max(m.varA + 2 * xMedian * m.covAB + xMedian * xMedian * m.varB, 0));
  const fogLocal = sigmoid(etaT + z90 * sdU) - sigmoid(etaT - z90 * sdU);
  const fogRain = p90 - p10;
  const fog = Math.min(1, Math.sqrt(fogRain ** 2 + fogLocal ** 2));
  return { p10, p50, p90, xMedian, fogRain, fogLocal, fog, state: stateOf(spec, p50, fog) };
}

/** The chance of over 900 after no rain at a site with this posterior (the predictive chance at x = 0). */
export const pDry = (spec: UpdateSpecFile, m: Moments): number => predictive(spec, m, 0);

export interface CitizenSample {
  /** Rain over the 48 h before the sample, the member median at that hour, mm. */
  readonly r48mm: number;
  readonly obs: Observation;
}

/** A sample's effect, kept whole so the screen can show what changed and the user can undo it. */
export interface SampleUpdate {
  readonly sample: CitizenSample;
  readonly before: Posterior;
  readonly after: Posterior;
}

export const applySample = (spec: UpdateSpecFile, before: Posterior, sample: CitizenSample): SampleUpdate => ({
  sample,
  before,
  after: update(spec, before, rainInput(sample.r48mm), sample.obs),
});

export const undoSample = (u: SampleUpdate): Posterior => u.before;
