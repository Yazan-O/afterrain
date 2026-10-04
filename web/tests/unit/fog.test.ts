import { describe, expect, it } from 'vitest';
import {
  applySample,
  hourSummary,
  moments,
  pDry,
  prior,
  quantileSorted,
  rainInput,
  softplus,
  undoSample,
  update,
  type Posterior,
} from '../../src/engine/fog';
import type { UpdateSpecFile } from '../../src/data/schemas';
import { disk } from './disk';

type Expected = UpdateSpecFile['prior_at_probe'];

function summarise(spec: UpdateSpecFile, post: Posterior, probeR48: readonly number[]): Expected {
  const m = moments(spec, post);
  const h = hourSummary(spec, m, probeR48.map(rainInput));
  return {
    mean_a: m.meanA,
    mean_b: m.meanB,
    var_a: m.varA,
    var_b: m.varB,
    cov_ab: m.covAB,
    p_dry: pDry(spec, m),
    p10: h.p10,
    p50: h.p50,
    p90: h.p90,
    x_median: h.xMedian,
    fog_rain: h.fogRain,
    fog_local: h.fogLocal,
    fog: h.fog,
    state: h.state,
  };
}

const TOL = 1e-9; // update_spec.json definitions.tolerance
const expectMatches = (got: Expected, want: Expected, label: string): void => {
  expect(got.state, `${label}: state`).toBe(want.state);
  for (const k of Object.keys(want) as (keyof Expected)[]) {
    if (k === 'state') continue;
    expect(Math.abs((got[k] as number) - (want[k] as number)), `${label}: ${k}`).toBeLessThan(TOL);
  }
};

describe('fog: citizen-sample update reproduced from update_spec.json', () => {
  it('states the tolerance this test uses', async () => {
    expect((await disk.updateSpec()).definitions['tolerance']).toBe('every expected value reproduces to 1e-9');
  });

  it('reproduces the prior at the probe hour', async () => {
    const spec = await disk.updateSpec();
    expectMatches(summarise(spec, prior(spec), spec.vectors[0]!.probe_members_r48_mm), spec.prior_at_probe, 'prior');
  });

  it('reproduces every vector to 1e-9, including the two-sample sequence', async () => {
    const spec = await disk.updateSpec();
    expect(spec.vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of spec.vectors) {
      let post = prior(spec);
      for (const st of v.steps) post = update(spec, post, rainInput(st.r48_mm), st.obs);
      expectMatches(summarise(spec, post, v.probe_members_r48_mm), v.expected, v.name);
    }
  });

  it('turns the storm-hour count of 31,000 into the state "high"', async () => {
    const spec = await disk.updateSpec();
    const v = spec.vectors.find((x) => x.steps.length === 1 && 'count' in x.steps[0]!.obs && x.steps[0]!.obs.count === 31000)!;
    expect(v.expected.state).toBe('high');
  });

  it('keeps each update undoable: the before state is returned untouched', async () => {
    const spec = await disk.updateSpec();
    const start = prior(spec);
    const copy = Float64Array.from(start.lw);
    const u = applySample(spec, start, { r48mm: 20, obs: { count: 31000 } });
    expect(u.after.lw).not.toEqual(start.lw);
    expect(undoSample(u)).toBe(start);
    expect(start.lw).toEqual(copy);
  });

  it('rejects a negative count', async () => {
    const spec = await disk.updateSpec();
    expect(() => update(spec, prior(spec), 0, { count: -1 })).toThrow(/non-negative/);
  });

  it('uses the stable softplus and the (n - 1) q quantile position', () => {
    expect(softplus(800)).toBe(800);
    expect(softplus(-800)).toBe(0);
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 1)).toBe(4);
    expect(() => quantileSorted([], 0.5)).toThrow(/empty/);
  });

  it('never names a state "safe"', async () => {
    const spec = await disk.updateSpec();
    expect(spec.definitions['state']).toMatch(/'usual'/);
    expect(JSON.stringify(spec)).not.toMatch(/\bsafe\b/i);
  });
});
