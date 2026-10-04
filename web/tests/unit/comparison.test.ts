// The opening's comparison: a low and a high test reading at Eiras (C4) at the demo's
// planned hour (src/model/demo.ts: Tue 6 Oct 14:00 UTC, hour 64 of the 3 Oct 22:31 UTC forecast), each from the same
// untested baseline; only the tested site changes, and the values at Eiras reproduce.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode } from '../../src/data/decode';
import { streamPackFile } from '../../src/data/schemas';
import { CityState } from '../../src/model/cityState';
import { DEMO, planDemo } from '../../src/model/demo';
import { probabilityColour } from '../../src/city/probabilityColour';
import { disk } from './disk';

const PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data', 'streams');
const pack = () => decode('streams/CO.json', streamPackFile('CO'), JSON.parse(readFileSync(resolve(PACKS, 'CO.json'), 'utf-8')));

describe('the opening comparison at Eiras, at the planned hour', () => {
  it('low and high start from the same baseline, reproduce at Eiras, and leave the other stations unchanged', async () => {
    const [spec, now] = await Promise.all([disk.updateSpec(), disk.nowcast('CO')]);
    const cs = new CityState(spec, pack(), now);
    const plan = planDemo(cs.hoursMs, (c, h) => cs.series(c).p50[h]!, cs.thresholds.higher);
    expect(plan.rule).toBe('fixed');
    expect(now.hours_utc[plan.hour]).toBe(DEMO.instantUtc);
    const H = plan.hour;
    const others = now.sites.filter((s) => s.code !== 'C4');
    const snap = () => others.map((s) => Array.from(cs.series(s.code).p50).concat(Array.from(cs.series(s.code).fog)));
    const base = snap();
    const b = cs.series('C4');
    const before = { p: b.p50[H]!, fog: b.fog[H]! };
    const low = cs.applyTestSample('C4', H, { over_900: false });
    const lowAt = { p: low.after.p50[H]!, fog: low.after.fog[H]! };
    expect(snap()).toEqual(base);
    cs.undo('C4');
    expect(cs.series('C4').p50[H]).toBe(before.p);
    const high = cs.applyTestSample('C4', H, { over_900: true });
    const highAt = { p: high.after.p50[H]!, fog: high.after.fog[H]! };
    expect(snap()).toEqual(base);
    expect(high.before.p50[H]).toBe(before.p);
    console.log(JSON.stringify({ hourUtc: now.hours_utc[H], before, lowAt, highAt, others: others.length }));
    // the forecast of 3 Oct 22:31 UTC with the censored count scale (2026-10-03); the 2 Oct forecast gave 0.4623,
    // 0.241 and 0.7196 at the same instant
    expect(before.p).toBeCloseTo(0.4559, 3);
    expect(before.fog).toBeCloseTo(0.9354, 3);
    expect(lowAt.p).toBeCloseTo(0.2384, 3);
    expect(lowAt.fog).toBeCloseTo(0.655, 3);
    expect(highAt.p).toBeCloseTo(0.7154, 3);
    expect(highAt.fog).toBeCloseTo(0.7242, 3);
    // the upstream reference (Escravote) keeps its value
    expect(cs.series(DEMO.upstream).p50[H]).toBeCloseTo(0.4559, 3);
    expect(others.length).toBe(19);
  });
});

describe('probabilityColour', () => {
  it('has the fixed stops and no jump at the old category boundary', () => {
    expect(probabilityColour(0)).toEqual([214, 236, 247]);
    expect(probabilityColour(0.5)).toEqual([255, 176, 58]);
    expect(probabilityColour(1)).toEqual([255, 88, 30]);
    const a = probabilityColour(0.2834),
      c = probabilityColour(0.2836);
    expect(Math.max(...a.map((v, i) => Math.abs(v - c[i]!)))).toBeLessThanOrEqual(1);
    expect(probabilityColour(0.37)).toEqual(probabilityColour(0.37));
    // clamped outside 0..1
    expect(probabilityColour(-1)).toEqual(probabilityColour(0));
    expect(probabilityColour(2)).toEqual(probabilityColour(1));
  });
});
