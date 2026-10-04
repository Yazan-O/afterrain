import { describe, expect, it } from 'vitest';
import { atHour, FLOW_KMH, fogWithDistance, FOG_KM, pointOnNetwork, pointOnStream, stateOf, type SiteSeries } from '../../src/model/alongStream';

const T = { higher: 0.28, high: 0.5, unknown_fog: 0.5 };
const S: Record<string, SiteSeries> = {
  A: { p50: [0.1, 0.2, 0.6], fog: [0.2, 0.3, 0.9] },
  B: { p50: [0.3, 0.4, 0.8], fog: [0.4, 0.4, 0.4] },
};
const series = (c: string): SiteSeries => S[c]!;
const stations = [
  { code: 'A', km: 1 },
  { code: 'B', km: 3 },
];

describe('the along-stream rule', () => {
  it('at a station: the station itself, no extra fog', () => {
    const p = pointOnStream(stations, series, 1, 0, T);
    expect(p.p50).toBeCloseTo(0.1);
    expect(p.fog).toBeCloseTo(0.2);
    expect(p.state).toBe('usual');
  });

  it('between two stations: both read at the same hour, interpolated by position; fog grows with distance to the nearest', () => {
    const p = pointOnStream(stations, series, 1.5, 1, T);
    expect(p.p50).toBeCloseTo(0.2 * 0.75 + 0.4 * 0.25);
    expect(p.fog).toBeCloseTo(1 - (1 - (0.3 * 0.75 + 0.4 * 0.25)) * Math.exp(-0.5 / FOG_KM));
  });

  it('below the last station: the nearest station upstream carries on, its state arriving later, fog rising downstream', () => {
    const p = pointOnStream(stations, series, 6, 1 + 3 / FLOW_KMH, T);
    expect(p.p50).toBeCloseTo(0.4);
    expect(p.fog).toBeCloseTo(fogWithDistance(0.4, 3));
    expect(p.fog).toBeGreaterThan(0.4);
  });

  it('above the first station: the first station downstream gives the chance, the water reaching it later', () => {
    const p = pointOnStream(stations, series, 0, 1 - 1 / FLOW_KMH, T);
    expect(p.p50).toBeCloseTo(0.2);
    expect(p.fog).toBeCloseTo(fogWithDistance(0.3, 1));
  });

  it('a storm arrives upstream first and leaves the mouth last: the peak time never decreases downstream', () => {
    const storm = { p50: Array.from({ length: 48 }, (_, i) => (i === 12 ? 0.9 : 0.05)), fog: Array.from({ length: 48 }, () => 0.2) };
    const two = [
      { code: 'A', km: 2 },
      { code: 'B', km: 5 },
    ];
    const peak = (km: number): number => {
      let best = -1;
      let at = -1;
      // 1/36 h steps land exactly on these travel times (FLOW_KMH = 1.8 km/h)
      for (let i = 0; i < 48 * 36; i++) {
        const h = i / 36;
        const v = pointOnStream(two, () => storm, km, h, T).p50;
        if (v > best) [best, at] = [v, h];
      }
      return at;
    };
    expect(peak(0)).toBeCloseTo(12 - 2 / FLOW_KMH, 6);
    expect(peak(2)).toBeCloseTo(12, 6);
    expect(peak(3.5)).toBeCloseTo(12, 6);
    expect(peak(5)).toBeCloseTo(12, 6);
    expect(peak(9)).toBeCloseTo(12 + 4 / FLOW_KMH, 6);
    let prev = -Infinity;
    for (let km = 0; km <= 10; km += 0.25) {
      const p = peak(km);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it('unknown overrides the chance when the fog passes the threshold, but the best guess stays', () => {
    const p = pointOnStream(stations, series, 1, 2, T);
    expect(p.state).toBe('unknown');
    expect(p.guess).toBe('high');
  });

  it('fog is monotone in distance and tends to 1', () => {
    let prev = 0;
    for (const d of [0, 0.5, 1, 2, 4, 8, 16]) {
      const f = fogWithDistance(0.3, d);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(fogWithDistance(0.3, 0)).toBeCloseTo(0.3);
    expect(fogWithDistance(0.3, 100)).toBeCloseTo(1, 6);
  });

  it('fractional hours interpolate; states follow the pipeline order', () => {
    expect(atHour([0, 1, 2], 1.5)).toBeCloseTo(1.5);
    expect(atHour([0, 1, 2], -3)).toBe(0);
    expect(atHour([0, 1, 2], 9)).toBe(2);
    expect(stateOf(0.6, 0.49, T)).toBe('high');
    expect(stateOf(0.3, 0.1, T)).toBe('higher');
    expect(stateOf(0.1, 0.1, T)).toBe('usual');
    expect(stateOf(0.1, 0.5, T)).toBe('unknown');
  });

  it('network vertices: nearest site by network distance', () => {
    const p = pointOnNetwork(S['B']!, 2, 0, T);
    expect(p.p50).toBeCloseTo(0.3);
    expect(p.fog).toBeCloseTo(fogWithDistance(0.4, 2));
  });

  it('a stream without stations is an error', () => {
    expect(() => pointOnStream([], series, 0, 0, T)).toThrow();
  });
});
