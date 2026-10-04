// The app keeps working through what a real link, a real clock and a failing scene throw at it: an old forecast
// is dated, never shown as now; one scene's broken frame never stops the others; a malformed link or query opens
// the app with defaults.
import { describe, expect, it, vi } from 'vitest';
import { clockOptionsFromQuery, clockOptionsLenient, createClock, parseInstant } from '../../src/app/clock';
import { parseHash, routeHash } from '../../src/app/router';
import { forecastNow } from '../../src/city/cityData';

const H = 3.6e6;
const T0 = Date.parse('2026-09-26T01:00:00Z');
const HOURS = Array.from({ length: 167 }, (_, i) => T0 + i * H);
const SCENES = ['replay', 'dark-hours'];

describe('a stale forecast is dated, never shown as now', () => {
  it('live while the forecast covers the clock (the strip ends where the forecast ends)', () => {
    const at = Date.parse('2026-09-28T06:00:00Z');
    expect(forecastNow(HOURS, at)).toEqual({ live: true, nowMs: at });
    const last = HOURS[HOURS.length - 1]!;
    expect(forecastNow(HOURS, last + 30 * 60e3)).toEqual({ live: true, nowMs: last + 30 * 60e3 });
  });

  it("past the forecast's last hour: not live, and now is the forecast's own first hour", () => {
    const last = HOURS[HOURS.length - 1]!;
    expect(forecastNow(HOURS, last + H)).toEqual({ live: false, nowMs: T0 });
    expect(forecastNow(HOURS, Date.parse('2026-10-08T12:00:00Z'))).toEqual({ live: false, nowMs: T0 });
  });

  it('a clock before the forecast is not live either (its first hour is not now)', () => {
    expect(forecastNow(HOURS, T0 - 5 * H)).toEqual({ live: false, nowMs: T0 });
  });
});

describe('the one frame loop isolates each scene', () => {
  it('a frame listener that throws is reported once; the others and the next frames still run', () => {
    let real = 0;
    const onError = vi.fn();
    const c = createClock({ startMs: null, rate: 1, manual: false }, () => real, onError);
    const seen: number[] = [];
    c.onFrame(() => {
      throw new TypeError("Cannot read properties of null (reading 'guess')");
    });
    c.onFrame((t) => seen.push(t.getTime()));
    for (let i = 0; i < 5; i++) {
      real += 16;
      c.frame(real);
    }
    expect(seen).toHaveLength(5);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toMatch(/guess/);
  });
});

describe('links and queries fall back to defaults', () => {
  it('a ?t without a zone is read as UTC, never in the viewer\'s zone', () => {
    expect(parseInstant('2026-09-28T06:00')).toBe(Date.parse('2026-09-28T06:00:00Z'));
    expect(parseInstant('2026-09-28T06:00:00')).toBe(Date.parse('2026-09-28T06:00:00Z'));
    expect(parseInstant('2026-09-28T06:00:00+02:00')).toBe(Date.parse('2026-09-28T04:00:00Z'));
    expect(parseInstant('2026-09-28')).toBe(Date.parse('2026-09-28T00:00:00Z'));
    expect(clockOptionsFromQuery('?t=2026-09-28T06:00').startMs).toBe(Date.parse('2026-09-28T06:00:00Z'));
  });

  it('a bad ?t or ?rate runs the clock from the real time (or keeps a good ?t), with the reason', () => {
    expect(clockOptionsLenient('?t=yesterday')).toEqual({ opts: { startMs: null, rate: 1, manual: false }, problems: [expect.stringMatching(/not an ISO date-time/)] });
    const r = clockOptionsLenient('?t=2026-09-28T06:00:00Z&rate=-5');
    expect(r.opts).toEqual({ startMs: Date.parse('2026-09-28T06:00:00Z'), rate: 0, manual: false });
    expect(r.problems[0]).toMatch(/rate/);
    expect(clockOptionsLenient('?t=2026-09-28T06:00:00Z&rate=60')).toEqual({ opts: { startMs: Date.parse('2026-09-28T06:00:00Z'), rate: 60, manual: false }, problems: [] });
  });

  it('a malformed escape in the hash never throws', () => {
    expect(() => parseHash('#/city/CO/stream/%E0%A4%A', SCENES)).not.toThrow();
    expect(parseHash('#/city/CO/stream/%E0%A4%A', SCENES)).toMatchObject({ kind: 'city', city: 'CO' });
    expect(() => parseHash('#/%E0%A4%A', SCENES)).not.toThrow();
    expect(routeHash(parseHash('#/%E0%A4%A', SCENES))).toBe('#/city/CO');
  });

  it('unknown cities, scenes and scene segments are corrected to what the screen shows', () => {
    expect(routeHash(parseHash('#/city/co', SCENES))).toBe('#/city/CO');
    expect(routeHash(parseHash('#/city/XX', SCENES))).toBe('#/city/CO');
    expect(routeHash(parseHash('#/nowhere', SCENES))).toBe('#/city/CO');
    expect(routeHash(parseHash('#/replay/1999-01-01', SCENES))).toBe('#/replay');
    expect(routeHash(parseHash('#/replay/2023-07-10/timetable', SCENES))).toBe('#/replay/2023-07-10/timetable');
    expect(routeHash(parseHash('#/dark-hours/nope', SCENES))).toBe('#/dark-hours');
    expect(routeHash(parseHash('#/dark-hours/storm', SCENES))).toBe('#/dark-hours/storm');
    expect(routeHash(parseHash('#/city/GH/stream/zwalmbeek', SCENES))).toBe('#/city/GH/stream/zwalmbeek');
  });
});
